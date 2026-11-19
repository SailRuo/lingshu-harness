import { getDb } from "../db/sqlite.js";
import { MEMORY_SEARCH as SEARCH } from "../contracts/native/nativeChatContract.js";
import { DIGEST_CONSTANTS } from "../contracts/native/index.js";
import { bufferToVector, cosineSimilarity, embedQueryText } from "./embeddingService.js";
import { memoryScope, type MemoryScope } from "./memoryScope.js";
import { displayTimeZone, zonedParts } from "./memoryTime.js";
import { formatRelativeTime } from "./memoryPromptBlocks.js";

/**
 * search_memory tool backend — time-scoped recall over streams + same-day raw
 * messages. Direct port of the APP (NativeMemoryTimeSearch), constants single-
 * sourced from the native chat contract (`MEMORY_SEARCH`).
 *
 * digest writes a stream after the 90s idle window, so created_at sits within
 * minutes of the covered conversation; ± WINDOW_SLACK_MS lets midnight-crossing
 * chats hit both adjacent days instead of being mis-bucketed.
 *
 * Read-only: this never writes a table and never generates new memories.
 */

const ZONE = "Asia/Shanghai";
const DAY_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

const DAYS_AGO = /^(\d{1,4})天前$/;
const WEEKDAY = /^上(?:周|礼拜|星期)([一二三四五六日天])$/;
const DATE_FULL = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})日?$/;
const DATE_MONTH_DAY = /^(\d{1,2})[-/月](\d{1,2})日?$/;

export interface SearchMemoryTimeWindow {
  start: Date;
  end: Date;
  label: string;
}

function zonedDayStart(date: Date): Date {
  const parts = zonedParts(date, ZONE);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - 8 * 3_600_000);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dayRange(startOfDay: Date): SearchMemoryTimeWindow {
  return { start: startOfDay, end: addDays(startOfDay, 1), label: "" };
}

function weekdayIndex(name: string): number {
  const index = "一二三四五六".indexOf(name);
  return index < 0 ? 6 : index; // 日 / 天
}

/** Monday 00:00 of the ISO week containing `date`, in Asia/Shanghai wall clock. */
function mondayOf(date: Date): Date {
  const parts = zonedParts(date, ZONE);
  // JS getUTCDay: 0=Sunday..6=Saturday → ISO weekday 1..7.
  const jsDay = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const dayStart = zonedDayStart(date);
  return addDays(dayStart, -(isoDay - 1));
}

function badTime(raw: string): Error {
  return new Error(
    `无法识别的时间表达「${raw}」。支持：具体日期（如 2026-09-15、9月15日）或 今天/昨天/前天/大前天/N天前/上周/上周一~上周日/上个月/最近`,
  );
}

/** One time expression → its natural range (Asia/Shanghai). APP resolveSingle. */
function resolveSingle(raw: string): SearchMemoryTimeWindow {
  const normalized = String(raw || "").trim().replace(/\s+/g, "");
  const today = zonedDayStart(new Date());
  switch (normalized) {
    case "今天":
      return { ...dayRange(today), label: "今天" };
    case "昨天":
      return { ...dayRange(addDays(today, -1)), label: "昨天" };
    case "前天":
      return { ...dayRange(addDays(today, -2)), label: "前天" };
    case "大前天":
      return { ...dayRange(addDays(today, -3)), label: "大前天" };
    case "最近":
    case "近来":
    case "前阵子":
    case "前段时间":
      return { start: addDays(today, -30), end: addDays(today, 1), label: "最近30天" };
    case "这几天":
    case "近几天":
      return { start: addDays(today, -7), end: addDays(today, 1), label: "最近7天" };
    case "上周":
    case "上一周":
    case "上礼拜": {
      const thisMonday = mondayOf(new Date());
      return { start: addDays(thisMonday, -7), end: thisMonday, label: "上周" };
    }
    case "上个月":
    case "上月": {
      const nowParts = zonedParts(new Date(), ZONE);
      const firstOfMonthUtc = Date.UTC(nowParts.year, nowParts.month - 1, 1);
      const thisMonthStart = new Date(firstOfMonthUtc - 8 * 3_600_000);
      return {
        start: addDays(thisMonthStart, -1),
        end: thisMonthStart,
        label: "上个月",
      };
    }
    default:
      break;
  }
  let match = WEEKDAY.exec(normalized);
  if (match) {
    const day = weekdayIndex(match[1]);
    const thisMonday = mondayOf(new Date());
    return dayRange(addDays(thisMonday, -7 + day));
  }
  match = DAYS_AGO.exec(normalized);
  if (match) {
    const days = Number(match[1]);
    if (!Number.isFinite(days) || days < 1 || days > 3650) throw badTime(raw);
    return dayRange(addDays(today, -days));
  }
  match = DATE_FULL.exec(normalized);
  if (match) {
    const year = Number(match[1]);
    if (year < 2000 || year > 2100) throw badTime(raw);
    const dayStart = parseYmd(year, Number(match[2]), Number(match[3]), raw);
    return dayRange(dayStart);
  }
  match = DATE_MONTH_DAY.exec(normalized);
  if (match) {
    const nowParts = zonedParts(new Date(), ZONE);
    let dayStart = parseYmd(nowParts.year, Number(match[1]), Number(match[2]), raw);
    if (dayStart.getTime() > addDays(today, 1).getTime()) {
      dayStart = parseYmd(nowParts.year - 1, Number(match[1]), Number(match[2]), raw);
    }
    return dayRange(dayStart);
  }
  throw badTime(raw);
}

function parseYmd(year: number, month: number, day: number, raw: string): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw badTime(raw);
  }
  return new Date(date.getTime() - 8 * 3_600_000);
}

function formatDay(date: Date): string {
  return DAY_FMT.format(date);
}

function weekdayLabel(date: Date): string {
  const parts = zonedParts(date, ZONE);
  const jsDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return `周${WEEKDAY_NAMES[(jsDay + 6) % 7]}`;
}

function describeWindow(start: Date, end: Date): string {
  if (end.getTime() - start.getTime() === 86_400_000) {
    return `${formatDay(start)}（${weekdayLabel(start)}）全天`;
  }
  return `${formatDay(start)}（${weekdayLabel(start)}）~ ${formatDay(end)}（${weekdayLabel(end)}）`;
}

/** `time` + optional `time_end` → the covering range (earlier start, later end). */
export function resolveSearchWindow(timeExpr: string, timeEnd?: string): SearchMemoryTimeWindow {
  const first = resolveSingle(timeExpr);
  if (!timeEnd || !String(timeEnd).trim()) return first;
  const second = resolveSingle(timeEnd);
  const start = first.start.getTime() <= second.start.getTime() ? first.start : second.start;
  const end = first.end.getTime() >= second.end.getTime() ? first.end : second.end;
  return { start, end, label: describeWindow(start, end) };
}

// ─── BM25 (CJK bigram + lowercase ASCII word tokens), APP-identical ─────────

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cjkRun: number[] = [];
  let asciiRun = "";
  const flushAscii = () => {
    if (asciiRun) {
      out.push(asciiRun);
      asciiRun = "";
    }
  };
  const flushCjk = () => {
    if (cjkRun.length === 1) {
      out.push(String.fromCodePoint(cjkRun[0]));
    } else if (cjkRun.length > 1) {
      for (let index = 0; index + 1 < cjkRun.length; index += 1) {
        out.push(String.fromCodePoint(cjkRun[index], cjkRun[index + 1]));
      }
    }
    cjkRun = [];
  };
  for (const char of String(text || "")) {
    const cp = char.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      flushAscii();
      cjkRun.push(cp);
    } else if (cp < 0x2e80 && /\p{L}|\p{N}/u.test(char)) {
      flushCjk();
      asciiRun += char.toLowerCase();
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return out;
}

/** BM25 over pre-tokenized docs — exported for the recall test suite. */
export function bm25Scores(docs: string[], queryTokens: string[], k1: number, b: number): number[] {
  const n = docs.length;
  const scores = new Array<number>(n).fill(0);
  if (!n || !queryTokens.length) return scores;
  const docTokens: string[][] = [];
  const df = new Map<string, number>();
  let totalLength = 0;
  for (const doc of docs) {
    const tokens = tokenize(doc);
    docTokens.push(tokens);
    totalLength += tokens.length;
    const seen = new Set(tokens);
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
  }
  const avgLength = totalLength / n;
  if (avgLength <= 0) return scores;
  for (let index = 0; index < n; index += 1) {
    const tf = new Map<string, number>();
    for (const token of docTokens[index]) tf.set(token, (tf.get(token) || 0) + 1);
    let score = 0;
    const length = docTokens[index].length;
    for (const token of queryTokens) {
      const freq = tf.get(token);
      if (!freq) continue;
      const tokenDf = df.get(token) || 0;
      const idf = Math.log(1 + (n - tokenDf + 0.5) / (tokenDf + 0.5));
      const norm = k1 * (1 - b + b * (length / avgLength));
      score += (idf * freq * (k1 + 1)) / (freq + norm);
    }
    scores[index] = score;
  }
  return scores;
}

function clip(raw: string, maxChars: number): string {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Relative time label for a hit line (今天/昨天/N天前/M月D日 …, APP
 * `_format_relative_time` semantics shared with the chat prompt blocks).
 * Stream created_at lags the conversation by the digest idle window, so the
 * label is computed on the corrected instant.
 */
function displayTime(createdAt: string | null | undefined, now: Date): string {
  const time = new Date(String(createdAt || "")).getTime();
  if (!Number.isFinite(time) || time <= 0) return String(createdAt || "");
  return formatRelativeTime(new Date(time - DIGEST_CONSTANTS.IDLE_MS).toISOString(), now);
}

/**
 * Public-provenance label (decided 2026-11-15): search_memory recalls this
 * agent's own group-public experiences and keeps them in the result, but never
 * passes them off as private-chat memories — the source rides on the hit line.
 * APP provenance wording, shared with the chat prompt blocks.
 */
function provenanceTag(originScope: string | null | undefined): string {
  const scope = String(originScope || "").trim();
  if (scope === "group_public") return "（来自曾共同在场的群聊公开经历）";
  if (scope === "theater_public") return "（来自与你的剧场共同经历）";
  return "";
}

interface StreamDoc {
  id: string;
  narrative: string;
  createdAt: string;
  originScope: string | null;
  embedding: Buffer | null;
}

interface MessageDoc {
  role: string;
  content: string;
  createdAt: string;
}

function loadStreams(
  scope: MemoryScope,
  startBound: string,
  endBound: string,
): StreamDoc[] {
  // DESC + reverse keeps the newest rows when a long window exceeds the cap.
  // Group-public streams (origin_scope='group_public') stay in the pool — they
  // are this agent's own memories; provenance is labeled on the output line.
  const rows = getDb()
    .prepare(
      `SELECT id, narrative, created_at, origin_scope, embedding FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0 AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ${SEARCH.STREAM_SCAN_CAP}`,
    )
    .all(scope.agentId, scope.userId, startBound, endBound) as {
    id: string;
    narrative: string;
    created_at: string;
    origin_scope: string | null;
    embedding: Buffer | null;
  }[];
  rows.reverse();
  return rows.map((row) => ({
    id: String(row.id),
    narrative: String(row.narrative || ""),
    createdAt: String(row.created_at || ""),
    originScope: row.origin_scope ?? null,
    embedding: row.embedding ?? null,
  }));
}

function loadMessages(
  scope: MemoryScope,
  startBound: string,
  endBound: string,
): MessageDoc[] {
  const rows = getDb()
    .prepare(
      `SELECT role, content, created_at FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND role IN ('user','assistant')
         AND message_kind = 'chat' AND TRIM(COALESCE(content, '')) != ''
         AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ${SEARCH.MESSAGE_SCAN_CAP}`,
    )
    .all(scope.agentId, scope.userId, startBound, endBound) as {
    role: string;
    content: string;
    created_at: string;
  }[];
  rows.reverse();
  return rows.map((row) => ({
    role: String(row.role),
    content: String(row.content || ""),
    createdAt: String(row.created_at || ""),
  }));
}

/**
 * RRF merge of the vector ranking and the BM25 ranking; documents absent from
 * both lists are dropped (APP rankStreams). Exported for the recall test suite.
 */
export function rankStreams(
  streams: StreamDoc[],
  bmScores: number[],
  queryVector: number[] | null,
  resultLimit: number,
): number[] {
  const n = streams.length;
  const similarities = new Map<number, number>();
  if (queryVector?.length) {
    for (let index = 0; index < n; index += 1) {
      const embedding = bufferToVector(streams[index].embedding);
      if (!embedding.length) continue;
      const similarity = cosineSimilarity(queryVector, embedding);
      if (similarity > 0) similarities.set(index, similarity);
    }
  }
  const vectorOrder = [...similarities.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([index]) => index);
  const bmOrder: number[] = [];
  for (let index = 0; index < n; index += 1) {
    if (bmScores[index] > 0) bmOrder.push(index);
  }
  bmOrder.sort((left, right) => bmScores[right] - bmScores[left]);

  const rrf = new Array<number>(n).fill(0);
  for (let rank = 0; rank < vectorOrder.length; rank += 1) {
    rrf[vectorOrder[rank]] += 1 / (SEARCH.RRF_K + rank + 1);
  }
  for (let rank = 0; rank < bmOrder.length; rank += 1) {
    rrf[bmOrder[rank]] += 1 / (SEARCH.RRF_K + rank + 1);
  }
  const merged: number[] = [];
  for (let index = 0; index < n; index += 1) {
    if (rrf[index] > 0) merged.push(index);
  }
  merged.sort((left, right) => rrf[right] - rrf[left]);
  return merged.slice(0, Math.max(1, resultLimit));
}

function rankMessages(bmScores: number[]): number[] {
  const order: number[] = [];
  for (let index = 0; index < bmScores.length; index += 1) {
    if (bmScores[index] > 0) order.push(index);
  }
  order.sort((left, right) => bmScores[right] - bmScores[left]);
  return order.slice(0, SEARCH.MESSAGE_RESULT_LIMIT);
}

export interface SearchMemoryInput {
  agentId: number;
  userId?: string | null;
  query: string;
  time: string;
  timeEnd?: string;
  now?: Date;
}

/**
 * search_memory execution. Returns the tool's text reply (the model speaks it
 * as "想起来的旧事"), or throws an Error whose message starts appropriately
 * for a failed call.
 */
export async function searchMemory(input: SearchMemoryInput): Promise<string> {
  const scope = memoryScope(input.agentId, input.userId);
  const query = String(input.query || "").trim();
  if (!query) {
    throw new Error("query 必填，用一句话或关键词描述要找的内容");
  }
  const timeExpr = String(input.time || "").trim();
  if (!timeExpr) {
    throw new Error(
      "time 必填，支持具体日期（2026-09-15、9月15日）或 今天/昨天/前天/大前天/N天前/上周/上周三/上个月/最近",
    );
  }
  const window = resolveSearchWindow(timeExpr, String(input.timeEnd || "").trim());
  const now = input.now || new Date();
  if (window.start.getTime() > now.getTime() + 86_400_000) {
    throw new Error("时间范围不能在未来；回忆检索只查过去");
  }
  const slack = SEARCH.WINDOW_SLACK_MS;
  const startBound = new Date(window.start.getTime() - slack).toISOString();
  const endBound = new Date(window.end.getTime() + slack).toISOString();

  const streams = loadStreams(scope, startBound, endBound);
  const messages = loadMessages(scope, startBound, endBound);
  const windowLabel = describeWindow(window.start, window.end);

  if (!streams.length && !messages.length) {
    return (
      `那段时间（${windowLabel}）脑海里是空白的。可以换个更宽的范围再想想` +
      `（如 time=最近，或 time=90天前、time_end=今天）；还是想不起什么，就照实告诉对方想不起来。`
    );
  }

  const queryTokens = tokenize(query);
  const streamBm = bm25Scores(
    streams.map((doc) => doc.narrative),
    queryTokens,
    SEARCH.BM25_K1,
    SEARCH.BM25_B,
  );
  const messageBm = bm25Scores(
    messages.map((doc) => doc.content),
    queryTokens,
    SEARCH.BM25_K1,
    SEARCH.BM25_B,
  );

  // Query-role embedding (BGE prefix). The embedding engine is optional here:
  // an unwarmed model degrades to keyword-only ranking instead of failing the
  // tool call.
  let queryVector: number[] | null = null;
  try {
    const embedded = await embedQueryText(query, { wait: true });
    if (embedded.vector?.length) queryVector = embedded.vector;
  } catch {
    queryVector = null;
  }

  let streamHits = rankStreams(streams, streamBm, queryVector, SEARCH.STREAM_RESULT_LIMIT);
  let messageHits = rankMessages(messageBm);

  if (!streamHits.length && !messageHits.length) {
    return (
      `那段时间（${windowLabel}）里，跟「${query}」相关的一点都没浮上来。` +
      `换个说法或更宽的范围再想想；还是没有，就照实说想不起这段。`
    );
  }

  // 回忆是顺着时间浮上来的：命中一律按发生时间升序输出，不按相关度排。
  // （相关度只决定谁进榜，不进文案。）
  streamHits = streamHits.slice().sort((left, right) =>
    streams[left].createdAt.localeCompare(streams[right].createdAt),
  );
  messageHits = messageHits.slice().sort((left, right) =>
    messages[left].createdAt.localeCompare(messages[right].createdAt),
  );

  const out: string[] = [];
  out.push(`你想起来了，${windowLabel}（上海时间）这段时间的事：`);
  if (streamHits.length) {
    out.push("浮上心头的记忆：");
    let rank = 1;
    for (const index of streamHits) {
      const doc = streams[index];
      out.push(
        `${rank++}. [${displayTime(doc.createdAt, now)}]${provenanceTag(doc.originScope)} ` +
          clip(doc.narrative, SEARCH.STREAM_PREVIEW_CHARS),
      );
    }
  }
  if (messageHits.length) {
    out.push("当时说过的话：");
    let rank = 1;
    for (const index of messageHits) {
      const doc = messages[index];
      out.push(
        `${rank++}. [${displayTime(doc.createdAt, now)}] ${doc.role === "user" ? "用户" : "我"}：` +
          clip(doc.content, SEARCH.MESSAGE_PREVIEW_CHARS),
      );
    }
  }
  out.push(
    "以上都是你想起来的旧事，已经按发生时间排好；用「我想起来了」「我记得那天…」这样的口气自然讲给对方，" +
      "就像旧事自己浮上心头。没被想起来的，就是想不起来，照实说。",
  );
  return out.join("\n");
}

/** Test/debug helper: the display time zone label used by the tool output. */
export function searchMemoryTimeZone(): string {
  return displayTimeZone();
}
