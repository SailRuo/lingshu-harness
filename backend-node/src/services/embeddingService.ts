import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/sqlite.js";
import { getModelsDir } from "../runtimePaths.js";
import { EMBEDDING as CHAT_EMBEDDING } from "../contracts/native/nativeChatContract.js";

export const EMBEDDING_DIM = 768;

/**
 * Chinese BGE asymmetric-retrieval contract (APP `EMBEDDING`):
 * the instruction goes on the *query* side only, stored documents are embedded
 * as-is (`DOCUMENT_PREFIX` is empty). Query-side callers must go through
 * `embedQueryText` / `embedQueryTextsCached`; document-side writers keep using
 * `embedText` unchanged.
 */
export const BGE_QUERY_PREFIX: string = CHAT_EMBEDDING.QUERY_PREFIX;
export const EMBEDDING_CONTRACT: string = CHAT_EMBEDDING.CONTRACT;
const LOCAL_MODEL_ID = "Xenova__bge-base-zh-v1.5";
const REMOTE_MODEL_ID = "Xenova/bge-base-zh-v1.5";

/**
 * Embedding ONNX is a hard dependency for memory. There is deliberately no
 * deterministic/hash fallback: a missing or broken model must surface as a 503
 * instead of silently writing pseudo-vectors that poison recall.
 */
export class EmbeddingUnavailableError extends Error {
  statusCode = 503;
  code = "embedding_unavailable";

  constructor(message = "记忆向量模型未就绪") {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

let extractor: any = null;
let loading: Promise<void> | null = null;
let loadError: string | null = null;
let ready = false;
let activeModel = LOCAL_MODEL_ID;
let activeModelPath: string | null = null;

function localModelRoots(): string[] {
  const roots: string[] = [];
  const envRoot = String(process.env.LINGSHU_EMBEDDING_MODEL_DIR || "").trim();
  if (envRoot) roots.push(envRoot);
  roots.push(path.join(getModelsDir(), "embeddings"));
  roots.push(path.join(process.cwd(), "models", "embeddings"));
  // Dev fallback: sibling lingshu-app-local project keeps the bundled model.
  roots.push(
    path.resolve(process.cwd(), "..", "..", "lingshu-app-local", ".lingshu", "models", "embeddings"),
  );
  roots.push(
    path.join(os.homedir(), "Project", "lingshu-app-local", ".lingshu", "models", "embeddings"),
  );
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function findLocalModel(): { root: string; modelId: string } | null {
  const onnxCandidates = ["onnx/model_quantized.onnx", "onnx/model_q8.onnx", "onnx/model.onnx"];
  for (const root of localModelRoots()) {
    for (const modelId of [LOCAL_MODEL_ID, REMOTE_MODEL_ID]) {
      const modelDir = path.join(root, modelId);
      if (onnxCandidates.some((file) => fs.existsSync(path.join(modelDir, file)))) {
        return { root, modelId };
      }
    }
  }
  return null;
}

async function loadModel() {
  if (extractor || loading) return loading;
  loading = (async () => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      const local = findLocalModel();
      if (!local) {
        loadError = `Embedding ONNX model not found under ${localModelRoots().join(", ")}`;
        ready = false;
        return;
      }
      env.localModelPath = local.root;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.useBrowserCache = false;
      extractor = await pipeline("feature-extraction", local.modelId, {
        dtype: "q8",
        model_file_name: "model",
      });
      activeModel = local.modelId;
      activeModelPath = path.join(local.root, local.modelId);
      ready = true;
      loadError = null;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      extractor = null;
      ready = false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function warmupEmbeddings() {
  return loadModel();
}

export function embeddingStatus() {
  return {
    ready,
    model: activeModel,
    local: Boolean(activeModelPath),
    modelPath: activeModelPath,
    dimension: EMBEDDING_DIM,
    kind: ready ? "onnx" : "unavailable",
    error: loadError,
  };
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

const normalize = normalizeVector;

export async function embedText(
  text: string,
  options: { wait?: boolean } = {},
): Promise<{ vector: number[]; kind: "onnx" }> {
  if (!extractor && options.wait) {
    await loadModel();
  } else if (!extractor && !loading) {
    void loadModel();
  }
  if (!extractor || !ready) {
    throw new EmbeddingUnavailableError(
      `记忆向量模型未就绪${loadError ? `：${loadError}` : ""}`,
    );
  }

  const content = String(text || "").trim();
  if (!content) return { vector: new Array(EMBEDDING_DIM).fill(0), kind: "onnx" };

  let output: any;
  try {
    output = await extractor(content, { pooling: "mean", normalize: true });
  } catch (error) {
    throw new EmbeddingUnavailableError(
      `记忆向量推理失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const data = Array.from(output.data as Float32Array);
  if (data.length !== EMBEDDING_DIM) {
    throw new EmbeddingUnavailableError(
      `记忆向量维度不匹配：expected ${EMBEDDING_DIM}, got ${data.length}`,
    );
  }
  return { vector: normalizeVector(data), kind: "onnx" };
}

/**
 * Query-side embedding under the BGE asymmetric contract: the retrieval
 * instruction prefix is added unless the caller already supplied it. Every
 * search-side path (stream recall, seed wake, search_memory, seed re-check,
 * recall debug) must go through this — mixing query vectors with the plain
 * document distribution shifted every cosine the recall floors were
 * calibrated against.
 */
export async function embedQueryText(
  text: string,
  options: { wait?: boolean } = {},
): Promise<{ vector: number[]; kind: "onnx" }> {
  const stripped = String(text || "").trim();
  const input = stripped.startsWith(BGE_QUERY_PREFIX) ? stripped : `${BGE_QUERY_PREFIX}${stripped}`;
  return embedText(input, options);
}

/** Document-side embedding: stored text stays unprefixed (EMBEDDING.DOCUMENT_PREFIX = ""). */
export async function embedDocumentText(
  text: string,
  options: { wait?: boolean } = {},
): Promise<{ vector: number[]; kind: "onnx" }> {
  return embedText(String(text || ""), options);
}

// ─── Near-window query embedding cache ───────────────────────────────────────
//
// Port of core/companion/query_embedding_cache.py. The recall path embeds the
// near-window utterances (≤3 user + ≤2 assistant) of the current turn, and the
// very same utterances are re-embedded on the next turn. This cache keeps the
// vectors that are still inside the window so a turn only pays ONNX inference
// for texts it has never seen before.
//
// Contract (deliberately narrow):
// - ONNX stays a hard dependency. A failed inference still throws
//   EmbeddingUnavailableError (surfaced as 503) and is never cached.
// - Only successful vectors are stored.
// - Empty queries are never cached (they carry no signal and would pollute
//   the window).

export interface QueryEmbeddingCacheOptions {
  /** Logical channel, mirroring the Python "recall" / "impression" channels. */
  channel?: string;
  /** Entry lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
  /** Max cached vectors per (session, channel). Default 16. */
  maxEntriesPerSession?: number;
  /** Max tracked (session, channel) buckets, LRU evicted. Default 64. */
  maxSessions?: number;
  /** Drop entries outside the current near-window before resolving. Default true. */
  pruneToWindow?: boolean;
}

export interface CachedQueryEmbedding {
  vector: number[];
  kind: "onnx";
  /** true when the vector was served from the cache (or shared in-flight). */
  cached: boolean;
}

const QUERY_CACHE_DEFAULT_CHANNEL = "recall";
const QUERY_CACHE_DEFAULT_TTL_MS = 10 * 60 * 1000;
const QUERY_CACHE_DEFAULT_MAX_ENTRIES = 16;
const QUERY_CACHE_DEFAULT_MAX_BUCKETS = 64;

interface QueryCacheEntry {
  vector: number[];
  createdAt: number;
}

/** bucketKey -> text -> entry (Map keeps insertion order = LRU order). */
const queryCacheBuckets = new Map<string, Map<string, QueryCacheEntry>>();
/** bucketKey + text -> in-flight inference promise (dedupes concurrent misses). */
const queryCacheInFlight = new Map<string, Promise<number[]>>();
const queryCacheStats = {
  hits: 0,
  misses: 0,
  shared: 0,
  embeds: 0,
  expired: 0,
  evicted: 0,
  pruned: 0,
};

/**
 * Session key for the query cache. Mirrors Python's make_session_key:
 * `agent_id:user_id:session_id`.
 */
export function makeQueryCacheSessionKey(input: {
  agentId: number;
  userId?: string | null;
  sessionId?: number | string | null;
}): string {
  const agentId = Number.isFinite(Number(input.agentId)) ? Number(input.agentId) : 0;
  const userId = String(input.userId ?? "default_user");
  const sessionId =
    input.sessionId === undefined || input.sessionId === null ? "none" : String(input.sessionId);
  return `${agentId}:${userId}:${sessionId}`;
}

function queryCacheBucketKey(sessionKey: string, channel: string): string {
  return `${sessionKey}::${channel}`;
}

function queryCacheTtl(options: QueryEmbeddingCacheOptions): number {
  const ttl = Number(options.ttlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : QUERY_CACHE_DEFAULT_TTL_MS;
}

function queryCacheMaxEntries(options: QueryEmbeddingCacheOptions): number {
  const max = Number(options.maxEntriesPerSession);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : QUERY_CACHE_DEFAULT_MAX_ENTRIES;
}

function queryCacheMaxBuckets(options: QueryEmbeddingCacheOptions): number {
  const max = Number(options.maxSessions);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : QUERY_CACHE_DEFAULT_MAX_BUCKETS;
}

function queryCacheChannel(options: QueryEmbeddingCacheOptions): string {
  return String(options.channel || QUERY_CACHE_DEFAULT_CHANNEL).trim() || QUERY_CACHE_DEFAULT_CHANNEL;
}

function pruneExpiredEntries(
  bucket: Map<string, QueryCacheEntry>,
  now: number,
  ttlMs: number,
): void {
  for (const [key, entry] of [...bucket.entries()]) {
    if (now - entry.createdAt > ttlMs) {
      bucket.delete(key);
      queryCacheStats.expired += 1;
    }
  }
}

/** Keep bucket insertion order == LRU order (oldest first). */
function touchQueryCacheBucket(bucketKey: string): void {
  const bucket = queryCacheBuckets.get(bucketKey);
  if (!bucket) return;
  queryCacheBuckets.delete(bucketKey);
  queryCacheBuckets.set(bucketKey, bucket);
}

function evictOverflowBuckets(maxBuckets: number): void {
  while (queryCacheBuckets.size > maxBuckets) {
    const oldest = queryCacheBuckets.keys().next();
    if (oldest.done) break;
    queryCacheBuckets.delete(oldest.value);
    queryCacheStats.evicted += 1;
  }
}

function lookupCachedQuery(
  sessionKey: string,
  channel: string,
  text: string,
  options: QueryEmbeddingCacheOptions,
): CachedQueryEmbedding | null {
  const bucketKey = queryCacheBucketKey(sessionKey, channel);
  const bucket = queryCacheBuckets.get(bucketKey);
  if (!bucket) return null;
  pruneExpiredEntries(bucket, Date.now(), queryCacheTtl(options));
  const entry = bucket.get(text);
  if (!entry) {
    if (!bucket.size) queryCacheBuckets.delete(bucketKey);
    return null;
  }
  // Refresh LRU position.
  bucket.delete(text);
  bucket.set(text, entry);
  touchQueryCacheBucket(bucketKey);
  queryCacheStats.hits += 1;
  return { vector: entry.vector, kind: "onnx", cached: true };
}

async function embedAndStoreQuery(
  sessionKey: string,
  channel: string,
  text: string,
  options: QueryEmbeddingCacheOptions,
): Promise<CachedQueryEmbedding> {
  const bucketKey = queryCacheBucketKey(sessionKey, channel);
  const inFlightKey = `${bucketKey}\u0000${text}`;
  const pending = queryCacheInFlight.get(inFlightKey);
  if (pending) {
    queryCacheStats.shared += 1;
    const vector = await pending;
    return { vector, kind: "onnx", cached: true };
  }
  const promise = embedText(text, { wait: true })
    .then((result) => {
      queryCacheStats.embeds += 1;
      const vector = result.vector;
      if (vector.length) {
        const ttlMs = queryCacheTtl(options);
        const now = Date.now();
        const bucket = queryCacheBuckets.get(bucketKey) ?? new Map<string, QueryCacheEntry>();
        pruneExpiredEntries(bucket, now, ttlMs);
        bucket.delete(text);
        bucket.set(text, { vector, createdAt: now });
        const maxEntries = queryCacheMaxEntries(options);
        while (bucket.size > maxEntries) {
          const oldest = bucket.keys().next();
          if (oldest.done) break;
          bucket.delete(oldest.value);
          queryCacheStats.evicted += 1;
        }
        queryCacheBuckets.set(bucketKey, bucket);
        touchQueryCacheBucket(bucketKey);
        evictOverflowBuckets(queryCacheMaxBuckets(options));
      }
      return vector;
    })
    .finally(() => {
      queryCacheInFlight.delete(inFlightKey);
    });
  queryCacheInFlight.set(inFlightKey, promise);
  const vector = await promise;
  return { vector, kind: "onnx", cached: false };
}

/**
 * Drop cached vectors of (session, channel) that fell out of the near-window.
 * Mirrors Python's prune_window.
 */
export function pruneQueryEmbeddingWindow(
  sessionKey: string,
  channel: string,
  keepKeys: Set<string>,
): number {
  const bucketKey = queryCacheBucketKey(sessionKey, channel);
  const bucket = queryCacheBuckets.get(bucketKey);
  if (!bucket) return 0;
  let pruned = 0;
  for (const key of [...bucket.keys()]) {
    if (!keepKeys.has(key)) {
      bucket.delete(key);
      pruned += 1;
    }
  }
  queryCacheStats.pruned += pruned;
  if (!bucket.size) queryCacheBuckets.delete(bucketKey);
  return pruned;
}

/**
 * Embed one query text, reusing the near-window vector of the same session
 * when possible. Never swallows inference failures.
 */
export async function embedQueryCached(
  sessionKey: string,
  text: string,
  options: QueryEmbeddingCacheOptions = {},
): Promise<CachedQueryEmbedding> {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    // Empty queries carry no signal; still go through embedText so a missing
    // ONNX model keeps surfacing as 503.
    const { vector } = await embedText(normalized, { wait: true });
    return { vector, kind: "onnx", cached: false };
  }
  const channel = queryCacheChannel(options);
  const hit = lookupCachedQuery(sessionKey, channel, normalized, options);
  if (hit) return hit;
  queryCacheStats.misses += 1;
  return embedAndStoreQuery(sessionKey, channel, normalized, options);
}

/**
 * Embed a batch of query texts with the near-window cache. Mirrors Python's
 * get_or_embed_many: prune to the window, serve hits, infer only the misses.
 */
export async function embedQueriesCached(
  sessionKey: string,
  texts: string[],
  options: QueryEmbeddingCacheOptions = {},
): Promise<CachedQueryEmbedding[]> {
  const channel = queryCacheChannel(options);
  const normalized = (texts || []).map((item) => String(item ?? "").trim());
  if (options.pruneToWindow !== false) {
    pruneQueryEmbeddingWindow(
      sessionKey,
      channel,
      new Set(normalized.filter((item) => item.length > 0)),
    );
  }
  const results: (CachedQueryEmbedding | null)[] = new Array(normalized.length).fill(null);
  const missIndexes: number[] = [];
  const emptyIndexes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const text = normalized[index];
    if (!text) {
      emptyIndexes.push(index);
      continue;
    }
    const hit = lookupCachedQuery(sessionKey, channel, text, options);
    if (hit) {
      results[index] = hit;
      continue;
    }
    missIndexes.push(index);
  }
  if (missIndexes.length) {
    queryCacheStats.misses += missIndexes.length;
    const embedded = await Promise.all(
      missIndexes.map((index) => embedAndStoreQuery(sessionKey, channel, normalized[index], options)),
    );
    missIndexes.forEach((index, position) => {
      results[index] = embedded[position];
    });
  }
  if (emptyIndexes.length) {
    const empty = await Promise.all(
      emptyIndexes.map(async (index) => {
        const { vector } = await embedText(normalized[index], { wait: true });
        return { vector, kind: "onnx" as const, cached: false };
      }),
    );
    emptyIndexes.forEach((index, position) => {
      results[index] = empty[position];
    });
  }
  return results.map((item) => item ?? { vector: [], kind: "onnx" as const, cached: false });
}

/**
 * Batch query embedding with the BGE query prefix applied.
 *
 * The cache bucket key is the *prefixed* text, so a query vector and the plain
 * document vector of the same sentence can never land in the same slot — the
 * two encodings are different distributions under the asymmetric contract.
 * `pruneQueryEmbeddingWindow` callers must pass the same prefixed keys; the
 * `keepKeys` helper below covers that.
 */
export async function embedQueryTextsCached(
  sessionKey: string,
  texts: string[],
  options: QueryEmbeddingCacheOptions = {},
): Promise<CachedQueryEmbedding[]> {
  const prefixed = (texts || []).map((item) => {
    const stripped = String(item ?? "").trim();
    return stripped.startsWith(BGE_QUERY_PREFIX) ? stripped : `${BGE_QUERY_PREFIX}${stripped}`;
  });
  return embedQueriesCached(sessionKey, prefixed, options);
}

/** Map raw query texts onto the prefixed cache keys `embedQueryTextsCached` stores. */
export function queryCacheKeys(texts: string[]): Set<string> {
  return new Set(
    (texts || []).map((item) => {
      const stripped = String(item ?? "").trim();
      return stripped.startsWith(BGE_QUERY_PREFIX) ? stripped : `${BGE_QUERY_PREFIX}${stripped}`;
    }),
  );
}

/**
 * Cache observability. Hit rate is measured over *requested non-empty query
 * texts*: hits / (hits + misses). Misses include texts that were inferred and
 * texts that joined an in-flight inference (see `shared`).
 */
export function queryEmbeddingCacheStats() {
  let entries = 0;
  for (const bucket of queryCacheBuckets.values()) entries += bucket.size;
  const requested = queryCacheStats.hits + queryCacheStats.misses;
  return {
    sessions: queryCacheBuckets.size,
    entries,
    inFlight: queryCacheInFlight.size,
    hits: queryCacheStats.hits,
    misses: queryCacheStats.misses,
    shared: queryCacheStats.shared,
    embeds: queryCacheStats.embeds,
    expired: queryCacheStats.expired,
    evicted: queryCacheStats.evicted,
    pruned: queryCacheStats.pruned,
    requested,
    hitRate: requested ? Number((queryCacheStats.hits / requested).toFixed(4)) : 0,
    policy: {
      strategy: "session-scoped LRU + TTL",
      defaultTtlMs: QUERY_CACHE_DEFAULT_TTL_MS,
      defaultMaxEntriesPerSession: QUERY_CACHE_DEFAULT_MAX_ENTRIES,
      defaultMaxSessions: QUERY_CACHE_DEFAULT_MAX_BUCKETS,
      defaultChannel: QUERY_CACHE_DEFAULT_CHANNEL,
    },
  };
}

/** Drop cached vectors for one session (or all sessions when omitted). */
export function clearQueryEmbeddingCache(sessionKey?: string): number {
  if (!sessionKey) {
    const dropped = [...queryCacheBuckets.values()].reduce((sum, bucket) => sum + bucket.size, 0);
    queryCacheBuckets.clear();
    queryCacheInFlight.clear();
    return dropped;
  }
  let dropped = 0;
  for (const key of [...queryCacheBuckets.keys()]) {
    if (!key.startsWith(`${sessionKey}::`)) continue;
    dropped += queryCacheBuckets.get(key)?.size ?? 0;
    queryCacheBuckets.delete(key);
  }
  return dropped;
}

export function vectorToBuffer(vector: number[]): Buffer {
  const float = new Float32Array(vector);
  return Buffer.from(float.buffer);
}

export function bufferToVector(buffer: Buffer | Uint8Array | null): number[] {
  if (!buffer) return [];
  const copy = Buffer.from(buffer);
  const float = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
  return Array.from(float);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || !right.length) return 0;
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function storeStreamEmbedding(streamId: string, vector: number[]) {
  const db = getDb();
  const buffer = vectorToBuffer(vector);
  db.prepare("UPDATE hippocampus_streams SET embedding = ?, embedding_dim = ? WHERE id = ?").run(
    buffer,
    vector.length,
    streamId,
  );
  try {
    db.prepare("DELETE FROM stream_vec WHERE stream_id = ?").run(streamId);
    db.prepare("INSERT INTO stream_vec (stream_id, embedding) VALUES (?, ?)").run(streamId, buffer);
  } catch {
    // vec0 extension unavailable
  }
}

/**
 * Remove every sqlite-vec shadow row owned by one agent+user scope. Clearing
 * memory deletes the source rows, but the vec0 tables are keyed by id alone —
 * without this sweep the ghosts stay in the ANN index and a later k-NN query
 * can spend its whole candidate window on deleted memories, degrading recall
 * to zero for the refilled scope. Scope isolation itself is never at risk: the
 * ANN readers always re-join the scoped source tables.
 */
export function deleteScopeVecRows(agentId: number, userId: string) {
  const db = getDb();
  const scopedIds = (table: string, idColumn: string) =>
    (
      db
        .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE agent_id = ? AND user_id = ?`)
        .all(agentId, userId) as { id: string }[]
    ).map((row) => String(row.id));
  const removals: Array<[string, string, string[]]> = [
    ["stream_vec", "stream_id", scopedIds("hippocampus_streams", "id")],
    ["seed_wake_vec", "seed_id", scopedIds("hippocampus_seeds", "id")],
    ["seed_boost_vec", "seed_id", scopedIds("hippocampus_seeds", "id")],
    ["seed_suppress_vec", "seed_id", scopedIds("hippocampus_seeds", "id")],
    ["entity_vec", "entity_id", scopedIds("hippocampus_entities", "id")],
  ];
  for (const [table, column, ids] of removals) {
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(",");
    try {
      db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...ids);
    } catch {
      // vec0 extension unavailable
    }
  }
}

export function storeSeedEmbeddings(
  seedId: string,
  wake: number[],
  boost: number[],
  suppress: number[],
) {
  const db = getDb();
  const wakeBuf = vectorToBuffer(wake);
  const boostBuf = vectorToBuffer(boost);
  const suppressBuf = vectorToBuffer(suppress);
  db.prepare(
    `UPDATE hippocampus_seeds
     SET wake_embedding = ?, boost_embedding = ?, suppress_embedding = ?, embedding_dim = ?
     WHERE id = ?`,
  ).run(wakeBuf, boostBuf, suppressBuf, wake.length, seedId);
  for (const [table, column, buffer] of [
    ["seed_wake_vec", "seed_id", wakeBuf],
    ["seed_boost_vec", "seed_id", boostBuf],
    ["seed_suppress_vec", "seed_id", suppressBuf],
  ] as const) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(seedId);
      db.prepare(`INSERT INTO ${table} (${column}, embedding) VALUES (?, ?)`).run(seedId, buffer);
    } catch {
      // vec0 extension unavailable
    }
  }
}

export function searchStreamCandidates(
  agentId: number,
  userId: string,
  queryVector: number[],
  limit: number,
): { streamId: string; similarity: number }[] {
  const db = getDb();
  if (!queryVector.length) return [];
  try {
    const rows = db
      .prepare(
        `SELECT stream_id, distance FROM stream_vec WHERE embedding MATCH ? AND k = ?`,
      )
      .all(vectorToBuffer(queryVector), Math.max(limit * 8, 32)) as {
      stream_id: string;
      distance: number;
    }[];
    if (rows.length) {
      const ids = rows.map((row) => row.stream_id);
      const placeholders = ids.map(() => "?").join(",");
      const scoped = db
        .prepare(
          `SELECT id, embedding FROM hippocampus_streams
           WHERE id IN (${placeholders}) AND agent_id = ? AND user_id = ? AND archived = 0`,
        )
        .all(...ids, agentId, userId) as { id: string; embedding: Buffer | null }[];
      const byId = new Map(scoped.map((row) => [row.id, row]));
      return rows
        .filter((row) => byId.has(row.stream_id))
        .map((row) => {
          const vector = bufferToVector(byId.get(row.stream_id)?.embedding ?? null);
          return {
            streamId: row.stream_id,
            similarity: vector.length ? cosineSimilarity(queryVector, vector) : 1 - row.distance,
          };
        })
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, limit);
    }
  } catch {
    // fall through to exact scan
  }

  const rows = db
    .prepare(
      `SELECT id, embedding FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0 AND embedding IS NOT NULL`,
    )
    .all(agentId, userId) as { id: string; embedding: Buffer | null }[];
  return rows
    .map((row) => ({
      streamId: row.id,
      similarity: cosineSimilarity(queryVector, bufferToVector(row.embedding)),
    }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit);
}
