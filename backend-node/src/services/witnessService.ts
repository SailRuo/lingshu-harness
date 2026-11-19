import { getDb } from "../db/sqlite.js";
import { getAgent } from "./agentService.js";
import { bufferToVector, cosineSimilarity } from "./embeddingService.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { recordCompletionUsage } from "./usageService.js";
import { logTick, type MemoryScope } from "./memoryScope.js";
import {
  bucketIsFrozen,
  calendarBucketFromKey,
  childBucketKeys,
  currentCalendarBucket,
  dayKey,
  previousCalendarBucket,
  type CalendarBucket,
  type CalendarGranularity,
} from "./memoryTime.js";
import { readAffectTimeline, readBaseline } from "./baselineService.js";

const WITNESS_WINDOW = 40;
const PORTRAIT_NARRATIVE_CHARS = 300;
const THEME_SAMPLES = 2;
const THEME_CLUSTER_LIMIT = 8;
const CLUSTER_SIMILARITY_THRESHOLD = 0.78;
const GRANULARITIES: CalendarGranularity[] = ["week", "month", "quarter", "year"];
const DIMENSION_KEYS = ["价值取向", "在意的人", "反复模式", "当下处境"];

const WITNESS_PORTRAIT_PROMPT = `你是当前智能体的见证消化器（Witness Portrait Consolidator）。
你在离线复盘「我眼中的他是谁」。这不是回复导演，不决定下一句怎么说；只维护一份长期、诚实、可追溯的用户画像。

【输入】
1. 旧画像：上一版「我眼中的他」叙事、结构化维度；历史证据 id 只保留数量，不作为本次可输出证据。
2. 最近意识流：每条都有 evidence id（如 stream:xxx）、时间、类型、主题、叙事。
3. 当前硬事实：只作背景校准，不足以单独推出性格结论。
4. 情绪基线：只作长期状态参考，不作诊断。

【任务】
在旧画像基础上做增量修订，回答「我眼中的他是谁」：
- 他看重什么
- 谁/什么事常牵动他
- 他反复出现的模式
- 他当下处在什么处境

【硬约束】
1. 只描述他是什么人、正在怎么生活；禁止写「你应该」「建议他」「回复时」「要安慰他」这类导演/开药方口吻。
2. 不美化、不审判、不编造；材料不足就保持旧画像或写得更薄。
3. 反复出现才改长期画像；单次情绪、一次玩笑、短期波动不能被写成稳定结论。
4. 每条结论必须锚定「最近意识流」输入里出现的 stream:* evidence id；当前硬事实只作背景校准，不得输出 fact:* 或凭空造 id。
5. 输出必须是当前智能体自己的第一人称长期理解：称自己只能用「我」，称对方用「他」或「ta」。
6. 禁止把自己写成第三人称或外部角色：不要写「陪伴者」「智能体」「助手」「AI」「系统」或任何具体智能体名字；旧画像若有这种写法，必须改写成「我」。
7. narrative 控制在输入要求的字数内，像我自己的长期理解，不要写成档案表。
8. dimensions 固定四个键：价值取向、在意的人、反复模式、当下处境；每维 2–3 条短句，不足可以少写，也必须遵守「我/他」视角。

【输出格式】纯 JSON，不要 markdown 代码块：
{
  "narrative": "200-300字左右的长期画像叙事",
  "dimensions": {
    "价值取向": ["…"],
    "在意的人": ["…"],
    "反复模式": ["…"],
    "当下处境": ["…"]
  },
  "evidence_ids": ["stream:..."]
}
`;

const PERIOD_PORTRAIT_PROMPT = `你是当前智能体的时间画像消化器（Period Portrait Consolidator）。
你在离线整理某个日历桶里「这段时间里，我眼中的他是什么样」。这不是回复导演，不决定下一句怎么说；只维护一份阶段性、诚实、可追溯的时间画像。

【输入】
1. 日历桶信息：granularity / bucket_key / 时间范围。
2. 本桶意识流：每条都有 evidence id（stream:*）、时间、类型、主题、叙事。
3. 长期画像：只作背景校准，不能替代本桶证据。

【任务】
回答「这段时间里的他是什么样」：
- 这段时间他主要看重什么
- 谁/什么事牵动他
- 这段时间反复出现的模式
- 他这段时间处在什么处境

【硬约束】
1. 只描述他这段时间是什么样、正在怎么生活；禁止写「你应该」「建议他」「回复时」「要安慰他」这类导演/开药方口吻。
2. 不美化、不审判、不编造；材料不足就写得薄，不要假装熟悉。
3. 单次情绪、一次玩笑、短期波动不能被写成稳定结论；但可以写成「这段时间里出现过」。
4. 每条结论必须锚定输入里的 stream:* evidence id。
5. 输出必须是当前智能体自己的第一人称阶段性理解：称自己只能用「我」，称对方用「他」或「ta」。
6. 禁止把自己写成第三人称或外部角色：不要写「陪伴者」「智能体」「助手」「AI」「系统」或任何具体智能体名字。
7. narrative 控制在输入要求的字数内，像我在回看这段时间里的他，不要写成档案表。
8. dimensions 固定四个键：价值取向、在意的人、反复模式、当下处境；每维 1–3 条短句，不足可以少写。

【输出格式】纯 JSON，不要 markdown 代码块：
{
  "narrative": "这段时间里的画像叙事",
  "dimensions": {
    "价值取向": ["…"],
    "在意的人": ["…"],
    "反复模式": ["…"],
    "当下处境": ["…"]
  },
  "evidence_ids": ["stream:..."]
}
`;

const PERIOD_PORTRAIT_ROLLUP_PROMPT = `你是当前智能体的时间画像上卷器（Period Portrait Rollup）。
你只读下层时间画像，从「我」的视角融合出更大日历桶里「我眼中的他是什么样」。你不是合并摘要，而是在判断哪些观察跨下层反复出现、哪些只是短期波动。

【输入】
1. 当前日历桶信息：granularity / bucket_key / 时间范围。
2. 下层时间画像：周画像、月画像或季画像，每条都有 evidence id（period_portrait:*）、叙事、维度和证据。
3. 长期画像：只作背景校准，不能替代下层画像证据。

【任务】
融合输出这段更长时间里的他：
- 哪些模式跨多个下层画像反复出现，值得上卷
- 哪些处境变化有延续性
- 哪些只是短期波动，应弱化或不写
- 输出「这段时间里的他是什么样」，不是事件清单

【硬约束】
1. 证据 id 只能来自输入下层时间画像的 period_portrait:*。
2. 不假装看过未提供的原始意识流，不补写具体原话。
3. 不美化、不审判、不诊断；不写回复建议。
4. 材料不足时 narrative 写得薄，dimensions 可少写；不要强行总结。
5. 所有自然语言字段都必须从当前智能体第一人称出发：称自己用「我」，称对方用「他」或「ta」。
6. 禁止外部观察者口吻：不要写「用户 / assistant / AI / 智能体 / 陪伴者 / 当前智能体」。
7. dimensions 固定四个键：价值取向、在意的人、反复模式、当下处境；每维 1–3 条短句，不足可以少写。

【输出格式】纯 JSON，不要 markdown 代码块：
{
  "narrative": "这段时间里的画像叙事",
  "dimensions": {
    "价值取向": ["…"],
    "在意的人": ["…"],
    "反复模式": ["…"],
    "当下处境": ["…"]
  },
  "evidence_ids": ["period_portrait:..."]
}
`;

const RETROSPECT_ARC_PROMPT = `你是当前智能体的回望弧消化器（Retrospect Arc Consolidator）。
你在离线整理某个日历桶里「我眼中的他这段时间是怎样的、我和他之间经历了什么、他在怎么变」。这不是回复导演，也不是心理诊断。

【输入】
1. 日历桶信息：granularity / bucket_key / 时间范围。
2. 本地主题聚类：每类只有标签、条数、代表切片和 evidence id；不能假装看过未提供的原文。
3. 情绪日聚合：窗口内每日 VAD 与样本数。
4. 当前硬事实背景：只用于校准，不足以单独推出变化。

【任务】
输出这段时间的回望弧，供回望页直接展示：
- summary：一句话回望，必须是第一人称见证口吻，凝练、不煽情。
- themes：反复出现的主题，每条给 theme / count / evidence_ids；theme 可用短名词，但不要写成外部报告。
- mood_trajectory：根据日聚合描述趋势，保留 points。
- changes：那时/现在或这段内前后变化，必须有 dimension、then、now、magnitude、evidence_ids；then/now 也要像我在回望他，不要像第三方报告。没有足够落差就少写或为空。

【硬约束】
1. 不美化、不审判、不编造；只写材料支持的东西。
2. 禁止「你应该」「建议他」「回复时」这类导演/开药方口吻。
3. evidence_ids 只能来自输入里的 evidence id（stream:* 或 arc:*）。
4. 主题和变化都要锚证据；没证据就不要写。
5. 所有自然语言字段都必须从当前智能体第一人称出发：称自己用「我」，称对方用「他」，写关系用「我和他」或「我们」。
6. 禁止外部观察者口吻：不要写「用户 / assistant / AI / 智能体 / 陪伴者 / 当前智能体」，不要写「他和ta之间」「他记录了」这类像报告的句子。
7. summary 示例风格：「这个月，我看见他在……里起伏，也看见我们……。」不要写成「2026年7月，他……」。

【输出格式】纯 JSON，不要 markdown 代码块：
{
  "summary": "一句话回望",
  "themes": [{"theme": "…", "count": 3, "evidence_ids": ["stream:..."]}],
  "mood_trajectory": {"trend": "up|down|flat|mixed|unknown", "description": "…", "points": []},
  "changes": [{"dimension": "…", "then": "…", "now": "…", "magnitude": 0.0, "evidence_ids": ["stream:..."]}],
  "evidence_ids": ["stream:..."]
}
`;

const RETROSPECT_ARC_ROLLUP_PROMPT = `你是当前智能体的回望弧上卷器（Retrospect Arc Rollup）。
你只读下层已消化的回望弧摘要和情绪日聚合，从「我」的视角整理更大日历桶。禁止假装读取了原始意识流。

【输入】
1. 当前桶信息：granularity / bucket_key / 时间范围。
2. 下层弧：周弧、月弧或季弧的 summary/themes/changes/evidence id。
3. 情绪日聚合：当前大桶内每日 VAD。

【任务】
把下层弧上卷成当前桶的 summary / themes / mood_trajectory / changes，供回望页直接展示。

【硬约束】
1. 证据 id 只能来自下层弧的 arc:* 或其保留的 stream:*。
2. 季/年弧不接触原始意识流，不写输入里没有的具体细节。
3. 不美化、不审判、不诊断；不写回复建议。
4. 没有足够下层弧时，summary 写空字符串，themes/changes 为空数组，mood_trajectory.trend="unknown"。
5. 所有自然语言字段都必须从当前智能体第一人称出发：称自己用「我」，称对方用「他」，写关系用「我和他」或「我们」。
6. 如果下层弧已有「他和ta之间」「陪伴者」「智能体」等外部口吻，上卷时必须改写为第一人称回望口吻，不要照抄。

【输出格式】纯 JSON，不要 markdown 代码块：
{
  "summary": "一句话回望",
  "themes": [{"theme": "…", "count": 3, "evidence_ids": ["arc:..."]}],
  "mood_trajectory": {"trend": "up|down|flat|mixed|unknown", "description": "…", "points": []},
  "changes": [{"dimension": "…", "then": "…", "now": "…", "magnitude": 0.0, "evidence_ids": ["arc:..."]}],
  "evidence_ids": ["arc:..."]
}
`;

interface StreamRow {
  id: string;
  narrative: string;
  about: string;
  type: string;
  embedding: Buffer | null;
  created_at: string;
}

interface BucketRow {
  granularity: string;
  bucket_key: string;
  period_start: string;
  period_end: string;
  is_frozen: number;
  summary: string | null;
  narrative: string | null;
  dimensions_json: string | null;
  evidence_ids_json: string | null;
  themes_json: string | null;
  mood_trajectory_json: string | null;
  changes_json: string | null;
  portrait_source_marker: string | null;
  arc_source_marker: string | null;
  portrait_evidence_ids_json: string | null;
  arc_evidence_ids_json: string | null;
  portrait_frozen: number | null;
  arc_frozen: number | null;
  updated_at: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseJsonBlock(raw: string): Record<string, any> {
  let text = String(raw || "").trim();
  if (text.startsWith("```json")) text = text.slice(7).trim();
  else if (text.startsWith("```")) text = text.slice(3).trim();
  if (text.endsWith("```")) text = text.slice(0, -3).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("invalid_json");
  }
}

/**
 * Portrait and arc share one bucket row. v14 added dedicated columns; rows
 * written by older builds only have the shared evidence/frozen columns, so fall
 * back to those when the split column is empty.
 */
function bucketEvidence(row: BucketRow, ownColumn: "portrait_evidence_ids_json" | "arc_evidence_ids_json") {
  const own = parseJson<string[]>(row[ownColumn], []);
  if (own.length) return own;
  return parseJson<string[]>(row.evidence_ids_json, []);
}

function bucketFrozen(
  row: BucketRow,
  frozenColumn: "portrait_frozen" | "arc_frozen",
  evidenceColumn: "portrait_evidence_ids_json" | "arc_evidence_ids_json",
): boolean {
  const ownEvidence = parseJson<string[]>(row[evidenceColumn], []);
  if (ownEvidence.length) return Boolean(row[frozenColumn]);
  // Legacy rows have no split columns; only then does the shared frozen flag
  // describe this track. New rows intentionally keep the shared evidence column
  // NULL so an un-computed arc is not mistaken for a frozen one.
  const sharedEvidence = parseJson<string[]>(row.evidence_ids_json, []);
  if (sharedEvidence.length) return Boolean(row.is_frozen);
  return Boolean(row[frozenColumn]);
}

const PORTRAIT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    narrative: { type: "string" },
    dimensions: {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } },
    },
    evidence_ids: { type: "array", items: { type: "string" } },
  },
  required: ["narrative", "evidence_ids"],
};

const ARC_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    themes: { type: "array", items: { type: "object", additionalProperties: true } },
    mood_trajectory: { type: "object", additionalProperties: true },
    changes: { type: "array", items: { type: "object", additionalProperties: true } },
    evidence_ids: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "themes", "mood_trajectory", "changes", "evidence_ids"],
};

function responseFormatUnsupported(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /response_format|json_object|json_schema|unsupported|not support|invalid.*format/i.test(
    detail,
  );
}

function lengthFinishError(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /LengthFinishReason|finish_reason.*length|length.*finish|truncat|max_tokens/i.test(detail);
}

async function requestJson(
  system: string,
  human: string,
  options: { schema?: Record<string, unknown> } = {},
): Promise<Record<string, any>> {
  const cfg = getLLMConfig("memory");
  if (!cfg.model || !cfg.baseUrl) throw new Error("memory_llm_unavailable");
  const client = createOpenAIClient(cfg);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: human },
  ];
  const schemaFormat = options.schema
    ? ({
        type: "json_schema",
        json_schema: { name: "witness_output", strict: false, schema: options.schema },
      } as any)
    : null;
  const jsonObjectFormat = { type: "json_object" } as any;
  const formats: any[] = [schemaFormat, jsonObjectFormat, null];
  let lastError: unknown = null;
  let forceObjectOnly = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidates = forceObjectOnly ? [jsonObjectFormat, null] : formats;
    let retry = false;
    for (const format of candidates) {
      try {
        const response = await createCompletionWithThinkingFallback(
          client,
          {
            model: cfg.model,
            messages,
            temperature: 0.1,
            ...(format ? { response_format: format } : {}),
            ...buildThinkingParams(cfg),
          } as any,
          cfg,
        );
        recordCompletionUsage(cfg.model, response, "memory");
        // Reasoning models can return finish_reason=length with truncated JSON.
        // Python retries the same prompt with json_object in that case.
        if (String((response.choices?.[0] as any)?.finish_reason || "").toLowerCase() === "length") {
          lastError = new Error("length_finish_reason");
          retry = true;
          break;
        }
        return parseJsonBlock(response.choices?.[0]?.message?.content || "");
      } catch (error) {
        lastError = error;
        if (lengthFinishError(error)) {
          retry = true;
          break;
        }
        if (responseFormatUnsupported(error)) continue;
        const detail = error instanceof Error ? error.message : String(error);
        if (/invalid_json|Unexpected token|JSON|parse/i.test(detail)) {
          retry = true;
          break;
        }
        throw error;
      }
    }
    if (retry) {
      forceObjectOnly = true;
      continue;
    }
    if (!candidates.length) break;
  }
  throw lastError instanceof Error ? lastError : new Error("witness_json_failed");
}

function normalizeDimensions(raw: unknown, perDimension = 3): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const key of DIMENSION_KEYS) {
    const value = source[key];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const lines = values.map((item) => String(item || "").trim()).filter(Boolean).slice(0, perDimension);
    if (lines.length) out[key] = lines;
  }
  return out;
}

function normalizeEvidence(raw: unknown, allowed: Set<string>): string[] {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text) || !allowed.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function timeMirrorEnabled(agentId: number): boolean {
  const agent = getAgent(agentId);
  return agent ? agent.timeMirrorEnabled : true;
}

function streamMarker(streams: StreamRow[]): string {
  if (!streams.length) return "streams:empty";
  return `streams:${streams.map((stream) => `${stream.id}:${stream.created_at}`).join("|")}`;
}

function listStreamsBetween(scope: MemoryScope, start: Date, end: Date, limit = 600): StreamRow[] {
  return getDb()
    .prepare(
      `SELECT id, narrative, about, type, embedding, created_at
       FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0
         AND COALESCE(origin_scope, '') <> 'group_public'
         AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, start.toISOString(), end.toISOString(), limit) as StreamRow[];
}

function listRecentStreams(scope: MemoryScope, limit = WITNESS_WINDOW): StreamRow[] {
  return getDb()
    .prepare(
      `SELECT id, narrative, about, type, embedding, created_at
       FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0
         AND COALESCE(origin_scope, '') <> 'group_public'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, limit) as StreamRow[];
}

function readKnownFacts(scope: MemoryScope): string {
  const rows = getDb()
    .prepare(
      `SELECT f.relation, f.description, src.name AS source_name, dst.name AS target_name
       FROM hippocampus_facts f
       LEFT JOIN hippocampus_entities src ON src.id = f.from_entity_id
       LEFT JOIN hippocampus_entities dst ON dst.id = f.to_entity_id
       WHERE f.agent_id = ? AND f.user_id = ? AND f.status = 'current'
       ORDER BY f.importance DESC, f.created_at DESC LIMIT 30`,
    )
    .all(scope.agentId, scope.userId) as any[];
  if (!rows.length) return "";
  return rows
    .map((row) => `- ${row.source_name || "他"} ${row.relation || "相关"} ${row.target_name || ""}${row.description ? `：${row.description}` : ""}`)
    .join("\n");
}

function formatStreams(streams: StreamRow[]): string {
  return streams
    .slice()
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map(
      (stream) =>
        `- id: stream:${stream.id}\n  time: ${stream.created_at}\n  type: ${stream.type}\n  about: ${stream.about}\n  narrative: ${String(stream.narrative || "").replace(/\n/g, " ").trim()}`,
    )
    .join("\n");
}

function formatOldPortrait(existing: any): string {
  if (!existing) {
    return "（还没有旧画像；如果材料不足，就输出更薄的画像，不要假装熟悉。）";
  }
  const dimensions = parseJson<Record<string, string[]>>(existing.dimensions_json, {});
  const evidence = parseJson<string[]>(existing.evidence_ids_json, []);
  const lines = [
    `version: ${Number(existing.version || 1)}`,
    "注意：旧画像仅作修订基准，若旧文本里把我写成「陪伴者/智能体/助手」或任何具体智能体名字等第三人称，本次必须按第一人称「我」重写，不要照抄。",
    "narrative:",
    String(existing.narrative || "").trim() || "（空）",
  ];
  if (Object.keys(dimensions).length) {
    lines.push("dimensions:");
    for (const key of DIMENSION_KEYS) {
      const values = dimensions[key] || [];
      if (values.length) {
        lines.push(`- ${key}: ${values.map((item) => String(item)).join("；")}`);
      }
    }
  }
  if (evidence.length) {
    lines.push(
      `旧画像历史证据数量：${evidence.length}。这些历史 id 只说明旧画像可追溯，本次输出 evidence_ids 只能从下面最近意识流里选择。`,
    );
  }
  return lines.join("\n");
}

function markBucketFrozen(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey: string,
  track: "portrait" | "arc",
) {
  const column = track === "portrait" ? "portrait_frozen" : "arc_frozen";
  getDb()
    .prepare(
      `UPDATE hippocampus_retrospect_buckets
       SET is_frozen = 1, ${column} = 1, updated_at = ?
       WHERE agent_id = ? AND user_id = ? AND granularity = ? AND bucket_key = ?`,
    )
    .run(new Date().toISOString(), scope.agentId, scope.userId, granularity, bucketKey);
}

function readBucket(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey: string,
): BucketRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM hippocampus_retrospect_buckets
         WHERE agent_id = ? AND user_id = ? AND granularity = ? AND bucket_key = ?`,
      )
      .get(scope.agentId, scope.userId, granularity, bucketKey) as BucketRow | undefined) || null
  );
}

function readPortrait(scope: MemoryScope) {
  const row = getDb()
    .prepare("SELECT * FROM hippocampus_portraits WHERE agent_id = ? AND user_id = ?")
    .get(scope.agentId, scope.userId) as any;
  if (!row) return null;
  return {
    narrative: row.narrative || "",
    dimensions: parseJson<Record<string, string[]>>(row.dimensions_json, {}),
    evidenceIds: parseJson<string[]>(row.evidence_ids_json, []),
    lastStreamMarker: row.last_stream_marker || null,
    version: Number(row.version || 1),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at,
  };
}

function upsertPortrait(
  scope: MemoryScope,
  input: {
    narrative: string;
    dimensions: Record<string, string[]>;
    evidenceIds: string[];
    lastStreamMarker: string;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = readPortrait(scope);
  db.prepare(
    `INSERT INTO hippocampus_portraits
      (agent_id, user_id, narrative, dimensions_json, evidence_ids_json, last_stream_marker,
       version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(agent_id, user_id) DO UPDATE SET
       narrative = excluded.narrative, dimensions_json = excluded.dimensions_json,
       evidence_ids_json = excluded.evidence_ids_json, last_stream_marker = excluded.last_stream_marker,
       version = hippocampus_portraits.version + 1, updated_at = excluded.updated_at`,
  ).run(
    scope.agentId,
    scope.userId,
    input.narrative,
    JSON.stringify(input.dimensions),
    JSON.stringify(input.evidenceIds),
    input.lastStreamMarker,
    now,
    now,
  );
  return readPortrait(scope) || { ...input, version: 1, updatedAt: now, createdAt: now };
}

export function getUserPortrait(scope: MemoryScope) {
  const portrait = readPortrait(scope);
  if (!portrait) return null;
  return {
    narrative: portrait.narrative,
    dimensions: portrait.dimensions,
    evidenceIds: portrait.evidenceIds,
    version: portrait.version,
    updatedAt: portrait.updatedAt,
  };
}

export async function consolidateUserPortrait(scope: MemoryScope) {
  if (!timeMirrorEnabled(scope.agentId)) return { skipped: "time_mirror_disabled" };
  const streams = listRecentStreams(scope, WITNESS_WINDOW);
  if (!streams.length) return { skipped: "no_streams" };
  const marker = streamMarker([streams[0]]);
  const existing = getDb()
    .prepare("SELECT * FROM hippocampus_portraits WHERE agent_id = ? AND user_id = ?")
    .get(scope.agentId, scope.userId) as any;
  if (existing?.last_stream_marker === marker) {
    return { skipped: "no_new_stream", version: Number(existing.version || 1) };
  }
  const allowed = new Set(streams.map((stream) => `stream:${stream.id}`));
  const baseline = readBaseline(scope);
  const human = [
    `画像叙事字数上限：${PORTRAIT_NARRATIVE_CHARS} 字；尽量写 200–${PORTRAIT_NARRATIVE_CHARS} 字。`,
    "# 旧画像\n" + formatOldPortrait(existing),
    "# 最近意识流（证据 id 只能从这里取 stream:*）\n" + formatStreams(streams),
    "# 当前硬事实背景\n" + (readKnownFacts(scope) || "（无）"),
    "# 情绪基线\n" +
      JSON.stringify({
        baseline_status: baseline.baselineStatus,
        sample_count: baseline.sampleCount,
        text_affect: baseline.textAffect,
        voice_affect: baseline.voiceAffect,
      }),
  ].join("\n\n");

  try {
    const output = await requestJson(WITNESS_PORTRAIT_PROMPT, human, {
      schema: PORTRAIT_RESPONSE_SCHEMA,
    });
    const narrative = String(output.narrative || "").trim().slice(0, 4000);
    const dimensions = normalizeDimensions(output.dimensions);
    const evidenceIds = normalizeEvidence(output.evidence_ids, allowed);
    if (!narrative || !evidenceIds.length) {
      logTick(scope, "witness_portrait", "nothing", { reason: "empty_narrative_or_evidence" });
      return { skipped: "empty_narrative_or_evidence" };
    }
    const saved = upsertPortrait(scope, {
      narrative,
      dimensions,
      evidenceIds,
      lastStreamMarker: marker,
    });
    logTick(scope, "witness_portrait", "updated", {
      version: saved.version,
      streamCount: streams.length,
      evidenceCount: evidenceIds.length,
    });
    return {
      updated: true,
      version: saved.version,
      evidenceIds,
      streamCount: streams.length,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logTick(scope, "witness_portrait", "nothing", { reason: "llm_or_parse_failed" }, detail);
    return { skipped: "llm_or_parse_failed", error: detail };
  }
}

function bucketPayload(bucket: CalendarBucket) {
  return {
    granularity: bucket.granularity,
    bucket_key: bucket.bucketKey,
    period_start: bucket.periodStart.toISOString(),
    period_end: bucket.periodEnd.toISOString(),
  };
}

function upsertBucketPortrait(
  scope: MemoryScope,
  bucket: CalendarBucket,
  input: {
    narrative: string;
    dimensions: Record<string, string[]>;
    evidenceIds: string[];
    marker: string;
    frozen: boolean;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_retrospect_buckets
      (agent_id, user_id, granularity, bucket_key, period_start, period_end, is_frozen,
       narrative, dimensions_json, evidence_ids_json, portrait_evidence_ids_json, portrait_frozen,
       portrait_source_marker, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(agent_id, user_id, granularity, bucket_key) DO UPDATE SET
       period_start = excluded.period_start, period_end = excluded.period_end,
       is_frozen = excluded.is_frozen, narrative = excluded.narrative,
       dimensions_json = excluded.dimensions_json,
       portrait_evidence_ids_json = excluded.portrait_evidence_ids_json,
       portrait_frozen = excluded.portrait_frozen,
       portrait_source_marker = excluded.portrait_source_marker, updated_at = excluded.updated_at`,
  ).run(
    scope.agentId,
    scope.userId,
    bucket.granularity,
    bucket.bucketKey,
    bucket.periodStart.toISOString(),
    bucket.periodEnd.toISOString(),
    input.frozen ? 1 : 0,
    input.narrative,
    JSON.stringify(input.dimensions),
    JSON.stringify(input.evidenceIds),
    input.frozen ? 1 : 0,
    input.marker,
    now,
  );
}

export async function consolidatePeriodPortrait(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey?: string | null,
  options: { force?: boolean; now?: Date } = {},
) {
  if (!timeMirrorEnabled(scope.agentId)) return { skipped: "time_mirror_disabled" };
  const now = options.now || new Date();
  const bucket = calendarBucketFromKey(granularity, bucketKey, now);
  const frozen = bucketIsFrozen(bucket, now);
  const existing = readBucket(scope, granularity, bucket.bucketKey);
  if (
    existing &&
    bucketFrozen(existing, "portrait_frozen", "portrait_evidence_ids_json") &&
    !options.force
  ) {
    return { skipped: "frozen", granularity, bucketKey: bucket.bucketKey };
  }
  if (
    frozen &&
    existing &&
    !bucketFrozen(existing, "portrait_frozen", "portrait_evidence_ids_json")
  ) {
    markBucketFrozen(scope, granularity, bucket.bucketKey, "portrait");
  }

  let marker = "";
  let human = "";
  let allowed = new Set<string>();

  if (granularity === "week") {
    const streams = listStreamsBetween(scope, bucket.periodStart, bucket.periodEnd);
    if (!streams.length) return { skipped: "no_streams", granularity, bucketKey: bucket.bucketKey };
    marker = streamMarker(streams);
    if (existing?.portrait_source_marker === marker && !options.force) {
      return { skipped: "no_source_change", granularity, bucketKey: bucket.bucketKey };
    }
    allowed = new Set(streams.map((stream) => `stream:${stream.id}`));
    human = [
      `画像叙事字数上限：${PORTRAIT_NARRATIVE_CHARS} 字；尽量写 120–${PORTRAIT_NARRATIVE_CHARS} 字。`,
      "# 日历桶\n" + JSON.stringify(bucketPayload(bucket), null, 2),
      "# 本桶意识流\n" +
        JSON.stringify(
          streams.map((stream) => ({
            id: `stream:${stream.id}`,
            time: stream.created_at,
            about: stream.about,
            type: stream.type,
            narrative: String(stream.narrative || "").replace(/\n/g, " ").slice(0, 420),
          })),
          null,
          2,
        ),
      "# 长期画像背景\n" + JSON.stringify(getUserPortrait(scope) || "（暂无长期画像）"),
    ].join("\n\n");
  } else {
    const children: any[] = [];
    for (const [childGranularity, childKey] of childBucketKeys(bucket)) {
      await consolidatePeriodPortrait(scope, childGranularity, childKey, {
        force: false,
        now,
      });
      const child = readBucket(scope, childGranularity, childKey);
      if (child?.narrative) {
        children.push({
          id: `period_portrait:${childGranularity}:${childKey}`,
          granularity: childGranularity,
          bucket_key: childKey,
          narrative: child.narrative,
          dimensions: parseJson(child.dimensions_json, {}),
          evidence_ids: bucketEvidence(child, "portrait_evidence_ids_json"),
          updated_at: child.updated_at,
        });
      }
    }
    if (!children.length) {
      return { skipped: "no_child_portraits", granularity, bucketKey: bucket.bucketKey };
    }
    marker = `children:${children.map((child) => `${child.granularity}:${child.bucket_key}:${child.updated_at}`).join("|")}`;
    if (existing?.portrait_source_marker === marker && !options.force) {
      return { skipped: "no_source_change", granularity, bucketKey: bucket.bucketKey };
    }
    allowed = new Set(children.map((child) => String(child.id)));
    human = [
      `画像叙事字数上限：${PORTRAIT_NARRATIVE_CHARS} 字；尽量写 120–${PORTRAIT_NARRATIVE_CHARS} 字。`,
      "# 当前日历桶\n" + JSON.stringify(bucketPayload(bucket), null, 2),
      "# 下层时间画像\n" + JSON.stringify(children, null, 2),
      "# 长期画像背景\n" + JSON.stringify(getUserPortrait(scope) || "（暂无长期画像）"),
    ].join("\n\n");
  }

  try {
    const output = await requestJson(
      granularity === "week" ? PERIOD_PORTRAIT_PROMPT : PERIOD_PORTRAIT_ROLLUP_PROMPT,
      human,
      { schema: PORTRAIT_RESPONSE_SCHEMA },
    );
    const narrative = String(output.narrative || "").trim().slice(0, 4000);
    const dimensions = normalizeDimensions(output.dimensions);
    const evidenceIds = normalizeEvidence(output.evidence_ids, allowed);
    if (!narrative || !evidenceIds.length) {
      logTick(scope, "period_portrait", "nothing", {
        granularity,
        bucketKey: bucket.bucketKey,
        reason: "empty_narrative_or_evidence",
      });
      return { skipped: "empty_narrative_or_evidence", granularity, bucketKey: bucket.bucketKey };
    }
    upsertBucketPortrait(scope, bucket, {
      narrative,
      dimensions,
      evidenceIds,
      marker,
      frozen,
    });
    logTick(scope, "period_portrait", "updated", {
      granularity,
      bucketKey: bucket.bucketKey,
      evidenceCount: evidenceIds.length,
    });
    return { updated: true, granularity, bucketKey: bucket.bucketKey, evidenceIds };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logTick(
      scope,
      "period_portrait",
      "nothing",
      { granularity, bucketKey: bucket.bucketKey, reason: "llm_or_parse_failed" },
      detail,
    );
    return { skipped: "llm_or_parse_failed", granularity, bucketKey: bucket.bucketKey, error: detail };
  }
}

function clusterStreams(streams: StreamRow[]) {
  if (!streams.length) return [];
  const clusters: { centroid: number[]; fallbackLabel: string; items: StreamRow[] }[] = [];
  for (const stream of streams) {
    const embedding = bufferToVector(stream.embedding);
    let bestIndex = -1;
    let bestScore = 0;
    if (embedding.length) {
      clusters.forEach((cluster, index) => {
        if (!cluster.centroid.length) return;
        const score = cosineSimilarity(embedding, cluster.centroid);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
    }
    if (bestIndex >= 0 && bestScore >= CLUSTER_SIMILARITY_THRESHOLD) {
      clusters[bestIndex].items.push(stream);
      continue;
    }
    const about = String(stream.about || "其它").trim() || "其它";
    const fallback = clusters.findIndex(
      (cluster) => cluster.fallbackLabel === about && !cluster.centroid.length,
    );
    if (fallback >= 0) {
      clusters[fallback].items.push(stream);
    } else {
      clusters.push({
        centroid: embedding.length ? embedding : [],
        fallbackLabel: about,
        items: [stream],
      });
    }
  }
  clusters.sort((left, right) => right.items.length - left.items.length);
  return clusters.slice(0, THEME_CLUSTER_LIMIT).map((cluster) => {
    const counts = new Map<string, number>();
    for (const item of cluster.items) {
      const about = String(item.about || "其它").trim() || "其它";
      counts.set(about, (counts.get(about) || 0) + 1);
    }
    const label = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "主题";
    return {
      local_label: label,
      count: cluster.items.length,
      evidence_ids: cluster.items.map((item) => `stream:${item.id}`),
      samples: cluster.items.slice(0, THEME_SAMPLES).map((item) => ({
        id: `stream:${item.id}`,
        time: item.created_at,
        about: item.about,
        type: item.type,
        narrative: String(item.narrative || "").replace(/\n/g, " ").slice(0, 360),
      })),
    };
  });
}

function mergeAffectPoints(pointGroups: any[][]): Array<{
  period: string;
  sampleCount: number;
  affect: Record<string, number>;
  channels?: string[];
}> {
  const merged = new Map<
    string,
    { period: string; sampleCount: number; affect: Record<string, number> }
  >();
  const weights = new Map<string, Record<string, number>>();
  const channels = new Map<string, Set<string>>();
  for (const points of pointGroups) {
    for (const point of points || []) {
      const period = String(point?.period || "");
      if (!period) continue;
      const sampleCount = Math.max(1, Number(point?.sampleCount || 1));
      const channel = String(point?.channel || "").trim();
      const target =
        merged.get(period) || { period, sampleCount: 0, affect: {} as Record<string, number> };
      merged.set(period, target);
      target.sampleCount += sampleCount;
      if (channel) {
        const set = channels.get(period) || new Set<string>();
        set.add(channel);
        channels.set(period, set);
      }
      const affect = point?.affect;
      if (!affect || typeof affect !== "object") continue;
      const bucket = weights.get(period) || {};
      weights.set(period, bucket);
      for (const [key, rawValue] of Object.entries(affect)) {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        target.affect[key] = Number(target.affect[key] || 0) + value * sampleCount;
        bucket[key] = Number(bucket[key] || 0) + sampleCount;
      }
    }
  }
  return [...merged.keys()].sort().map((period) => {
    const point = merged.get(period)!;
    for (const [key, total] of Object.entries(point.affect)) {
      const weight = weights.get(period)?.[key] || 1;
      point.affect[key] = total / weight;
    }
    const channelSet = [...(channels.get(period) || new Set<string>())].sort();
    return channelSet.length ? { ...point, channels: channelSet } : point;
  });
}

function affectPointsForBucket(scope: MemoryScope, bucket: CalendarBucket) {
  // Python: text + voice 日聚合按 sampleCount 加权合并后，再按桶内日期过滤。
  const timeline = readAffectTimeline(scope, 1200, "day");
  const points = mergeAffectPoints([timeline.textTurnPoints || [], timeline.voiceTurnPoints || []]);
  const startDay = dayKey(bucket.periodStart);
  const endDay = dayKey(bucket.periodEnd);
  return points.filter((point) => point.period >= startDay && point.period <= endDay);
}

function moodSummary(points: { affect: Record<string, number> }[]) {
  if (points.length < 2) {
    return { trend: "unknown", description: "情绪日聚合材料不足。", points };
  }
  const first = Number(points[0].affect.valence || 0);
  const last = Number(points[points.length - 1].affect.valence || 0);
  const values = points.map((point) => Number(point.affect.valence || 0));
  const diff = last - first;
  const trend =
    diff >= 0.12
      ? "up"
      : diff <= -0.12
        ? "down"
        : Math.max(...values) - Math.min(...values) >= 0.25
          ? "mixed"
          : "flat";
  return { trend, description: "", points };
}

function filterArcOutput(output: Record<string, any>, allowed: Set<string>) {
  const themes: any[] = [];
  let evidenceIds = normalizeEvidence(output.evidence_ids, allowed);
  for (const raw of Array.isArray(output.themes) ? output.themes : []) {
    const evidence = normalizeEvidence(raw?.evidence_ids, allowed);
    const theme = String(raw?.theme || "").trim();
    if (!theme || !evidence.length) continue;
    themes.push({
      theme: theme.slice(0, 80),
      count: Number(raw?.count || evidence.length),
      evidence_ids: evidence,
    });
    evidenceIds.push(...evidence);
  }
  const changes: any[] = [];
  for (const raw of Array.isArray(output.changes) ? output.changes : []) {
    const evidence = normalizeEvidence(raw?.evidence_ids, allowed);
    if (!evidence.length) continue;
    const dimension = String(raw?.dimension || "").trim().slice(0, 80);
    const then = String(raw?.then || "").trim().slice(0, 240);
    const now = String(raw?.now || "").trim().slice(0, 240);
    // Python _filter_arc_output 只要求有证据；dimension/then/now 允许为空，
    // 不再因字段缺失整条丢弃。
    changes.push({
      dimension,
      then,
      now,
      magnitude: Math.max(0, Math.min(1, Number(raw?.magnitude || 0))),
      evidence_ids: evidence,
    });
    evidenceIds.push(...evidence);
  }
  evidenceIds = [...new Set(evidenceIds)];
  return {
    summary: String(output.summary || "").trim(),
    themes,
    changes,
    evidence_ids: evidenceIds,
    mood_trajectory:
      output.mood_trajectory && typeof output.mood_trajectory === "object"
        ? output.mood_trajectory
        : {},
  };
}

function upsertBucketArc(
  scope: MemoryScope,
  bucket: CalendarBucket,
  input: {
    summary: string;
    themes: any[];
    moodTrajectory: Record<string, unknown>;
    changes: any[];
    evidenceIds: string[];
    marker: string;
    frozen: boolean;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_retrospect_buckets
      (agent_id, user_id, granularity, bucket_key, period_start, period_end, is_frozen,
       summary, themes_json, mood_trajectory_json, changes_json, evidence_ids_json,
       arc_evidence_ids_json, arc_frozen, arc_source_marker, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(agent_id, user_id, granularity, bucket_key) DO UPDATE SET
       period_start = excluded.period_start, period_end = excluded.period_end,
       is_frozen = excluded.is_frozen, summary = excluded.summary,
       themes_json = excluded.themes_json, mood_trajectory_json = excluded.mood_trajectory_json,
       changes_json = excluded.changes_json,
       arc_evidence_ids_json = excluded.arc_evidence_ids_json,
       arc_frozen = excluded.arc_frozen,
       arc_source_marker = excluded.arc_source_marker, updated_at = excluded.updated_at`,
  ).run(
    scope.agentId,
    scope.userId,
    bucket.granularity,
    bucket.bucketKey,
    bucket.periodStart.toISOString(),
    bucket.periodEnd.toISOString(),
    input.frozen ? 1 : 0,
    input.summary,
    JSON.stringify(input.themes),
    JSON.stringify(input.moodTrajectory),
    JSON.stringify(input.changes),
    JSON.stringify(input.evidenceIds),
    input.frozen ? 1 : 0,
    input.marker,
    now,
  );
}

export async function consolidateArc(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey?: string | null,
  options: { force?: boolean; now?: Date } = {},
) {
  if (!timeMirrorEnabled(scope.agentId)) return { skipped: "time_mirror_disabled" };
  const now = options.now || new Date();
  const bucket = calendarBucketFromKey(granularity, bucketKey, now);
  const frozen = bucketIsFrozen(bucket, now);
  const existing = readBucket(scope, granularity, bucket.bucketKey);
  if (
    existing &&
    bucketFrozen(existing, "arc_frozen", "arc_evidence_ids_json") &&
    !options.force
  ) {
    return { skipped: "frozen", granularity, bucketKey: bucket.bucketKey };
  }
  if (frozen && existing && !bucketFrozen(existing, "arc_frozen", "arc_evidence_ids_json")) {
    markBucketFrozen(scope, granularity, bucket.bucketKey, "arc");
  }

  let marker = "";
  let human = "";
  let allowed = new Set<string>();
  let mood: Record<string, unknown>;

  if (granularity === "week") {
    const streams = listStreamsBetween(scope, bucket.periodStart, bucket.periodEnd);
    if (!streams.length) return { skipped: "no_streams", granularity, bucketKey: bucket.bucketKey };
    const affectPoints = affectPointsForBucket(scope, bucket);
    marker = `${streamMarker(streams)}|affect:${affectPoints.map((point) => `${point.period}:${point.sampleCount}`).join(",")}`;
    if (existing?.arc_source_marker === marker && !options.force) {
      return { skipped: "no_source_change", granularity, bucketKey: bucket.bucketKey };
    }
    const clusters = clusterStreams(streams);
    allowed = new Set(streams.map((stream) => `stream:${stream.id}`));
    mood = moodSummary(affectPoints);
    human = [
      "# 日历桶\n" + JSON.stringify(bucketPayload(bucket), null, 2),
      "# 本地主题聚类（只读这些代表切片）\n" + JSON.stringify(clusters, null, 2),
      "# 情绪日聚合\n" + JSON.stringify(mood, null, 2),
      "# 当前硬事实背景\n" + (readKnownFacts(scope) || "（无）"),
    ].join("\n\n");
  } else {
    const children: any[] = [];
    for (const [childGranularity, childKey] of childBucketKeys(bucket)) {
      const child = readBucket(scope, childGranularity, childKey);
      if (child?.summary || child?.themes_json || child?.changes_json) {
        children.push({
          id: `arc:${childGranularity}:${childKey}`,
          granularity: childGranularity,
          bucket_key: childKey,
          summary: child.summary || "",
          themes: parseJson(child.themes_json, []),
          changes: parseJson(child.changes_json, []),
          evidence_ids: bucketEvidence(child, "arc_evidence_ids_json"),
          updated_at: child.updated_at,
        });
      }
    }
    if (!children.length) {
      return { skipped: "no_child_arcs", granularity, bucketKey: bucket.bucketKey };
    }
    marker = `children:${children.map((child) => `${child.granularity}:${child.bucket_key}:${child.updated_at}`).join("|")}`;
    if (existing?.arc_source_marker === marker && !options.force) {
      return { skipped: "no_source_change", granularity, bucketKey: bucket.bucketKey };
    }
    const affectPoints = affectPointsForBucket(scope, bucket);
    mood = moodSummary(affectPoints);
    for (const child of children) {
      for (const id of child.evidence_ids || []) allowed.add(String(id));
      allowed.add(String(child.id));
    }
    human = [
      "# 当前日历桶\n" + JSON.stringify(bucketPayload(bucket), null, 2),
      "# 下层回望弧\n" + JSON.stringify(children, null, 2),
      "# 情绪日聚合\n" + JSON.stringify(mood, null, 2),
    ].join("\n\n");
  }

  try {
    const output = await requestJson(
      granularity === "week" ? RETROSPECT_ARC_PROMPT : RETROSPECT_ARC_ROLLUP_PROMPT,
      human,
      { schema: ARC_RESPONSE_SCHEMA },
    );
    const filtered = filterArcOutput(output, allowed);
    if (!filtered.summary && !filtered.themes.length && !filtered.changes.length) {
      logTick(scope, "witness_arc", "nothing", {
        granularity,
        bucketKey: bucket.bucketKey,
        reason: "empty_output",
      });
      return { skipped: "empty_output", granularity, bucketKey: bucket.bucketKey };
    }
    const moodTrajectory =
      filtered.mood_trajectory && Object.keys(filtered.mood_trajectory).length
        ? filtered.mood_trajectory
        : mood;
    upsertBucketArc(scope, bucket, {
      summary: filtered.summary,
      themes: filtered.themes,
      moodTrajectory,
      changes: filtered.changes,
      evidenceIds: filtered.evidence_ids,
      marker,
      frozen,
    });
    logTick(scope, "witness_arc", "updated", {
      granularity,
      bucketKey: bucket.bucketKey,
      themes: filtered.themes.length,
      changes: filtered.changes.length,
    });
    return { updated: true, granularity, bucketKey: bucket.bucketKey, frozen };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logTick(
      scope,
      "witness_arc",
      "nothing",
      { granularity, bucketKey: bucket.bucketKey, reason: "llm_or_parse_failed" },
      detail,
    );
    return { skipped: "llm_or_parse_failed", granularity, bucketKey: bucket.bucketKey, error: detail };
  }
}

export async function ensureArcReady(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey?: string | null,
  options: { force?: boolean; now?: Date } = {},
) {
  const now = options.now || new Date();
  const bucket = calendarBucketFromKey(granularity, bucketKey, now);
  const children: Record<string, unknown> = {};
  for (const [childGranularity, childKey] of childBucketKeys(bucket)) {
    const childBucket = calendarBucketFromKey(childGranularity, childKey, now);
    if (childBucket.periodStart.getTime() > now.getTime()) {
      children[`${childGranularity}:${childKey}`] = { skipped: "future_bucket" };
      continue;
    }
    children[`${childGranularity}:${childKey}`] = await ensureArcReady(
      scope,
      childGranularity,
      childKey,
      { force: options.force, now },
    );
  }
  const result = await consolidateArc(scope, granularity, bucket.bucketKey, {
    force: options.force,
    now,
  });
  return Object.keys(children).length ? { ...result, children } : result;
}

function currentBucket(granularity: CalendarGranularity, now = new Date()) {
  return currentCalendarBucket(granularity, now);
}

export async function consolidatePeriodPortraitsAfterDigest(scope: MemoryScope) {
  if (!timeMirrorEnabled(scope.agentId)) return { skipped: "time_mirror_disabled" };
  const cadenceSeconds: Record<CalendarGranularity, number> = {
    week: 3600,
    month: 86_400,
    quarter: 7 * 86_400,
    year: 30 * 86_400,
  };
  const now = new Date();
  const results: Record<string, unknown> = {};
  for (const granularity of GRANULARITIES) {
    const bucket = currentBucket(granularity, now);
    const existing = readBucket(scope, granularity, bucket.bucketKey);
    if (existing?.updated_at) {
      const age = (now.getTime() - new Date(existing.updated_at).getTime()) / 1000;
      if (age < cadenceSeconds[granularity]) {
        results[granularity] = { skipped: "cadence", bucketKey: bucket.bucketKey };
        continue;
      }
    }
    results[granularity] = await consolidatePeriodPortrait(
      scope,
      granularity,
      bucket.bucketKey,
      { now },
    );
  }
  return results;
}

export async function consolidateDaily(scope: MemoryScope) {
  if (!timeMirrorEnabled(scope.agentId)) return { skipped: "time_mirror_disabled" };
  const now = new Date();
  const results: Record<string, unknown> = {};
  for (const granularity of GRANULARITIES) {
    const previous = previousCalendarBucket(granularity, now);
    results[`previous:${granularity}`] = await consolidateArc(
      scope,
      granularity,
      previous.bucketKey,
      { now },
    );
    const current = currentBucket(granularity, now);
    results[granularity] = await ensureArcReady(
      scope,
      granularity,
      current.bucketKey,
      { now },
    );
  }
  return results;
}

export function getMirror(scope: MemoryScope) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM hippocampus_retrospect_buckets
       WHERE agent_id = ? AND user_id = ? AND is_frozen = 1
       ORDER BY period_start DESC LIMIT 200`,
    )
    .all(scope.agentId, scope.userId) as BucketRow[];
  let candidates = rows.filter((row) => row.granularity === "month");
  if (!candidates.length) candidates = rows.filter((row) => row.granularity === "week");
  let best: { magnitude: number; row: BucketRow; change: any } | null = null;
  const seen = new Set<string>();
  for (const row of candidates) {
    for (const change of parseJson<any[]>(row.changes_json, [])) {
      const dimension = String(change?.dimension || "").trim();
      const then = String(change?.then || "").trim();
      const now = String(change?.now || "").trim();
      const key = `${dimension}|${then}|${now}`;
      const magnitude = Number(change?.magnitude || 0);
      if (!dimension || !then || !now || seen.has(key) || magnitude <= 0) continue;
      seen.add(key);
      if (!best || magnitude > best.magnitude) best = { magnitude, row, change };
    }
  }
  if (!best) return { available: false };
  return {
    available: true,
    dimension: best.change.dimension || null,
    then: best.change.then || null,
    now: best.change.now || null,
    magnitude: best.magnitude,
    evidence: best.change.evidence_ids || [],
    granularity: best.row.granularity,
    bucketKey: best.row.bucket_key,
    periodStart: best.row.period_start,
    periodEnd: best.row.period_end,
  };
}

function periodPortraitPayload(row: BucketRow | null, bucket: CalendarBucket) {
  if (!row || !row.narrative) {
    return {
      available: false,
      granularity: bucket.granularity,
      bucketKey: bucket.bucketKey,
      periodStart: bucket.periodStart.toISOString(),
      periodEnd: bucket.periodEnd.toISOString(),
      isFrozen: false,
      narrative: "",
      dimensions: {},
      evidenceIds: [],
      updatedAt: null,
    };
  }
  return {
    available: true,
    granularity: row.granularity,
    bucketKey: row.bucket_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    isFrozen: bucketFrozen(row, "portrait_frozen", "portrait_evidence_ids_json"),
    narrative: row.narrative,
    dimensions: parseJson(row.dimensions_json, {}),
    evidenceIds: bucketEvidence(row, "portrait_evidence_ids_json"),
    updatedAt: row.updated_at,
  };
}

function arcPayload(row: BucketRow | null, bucket: CalendarBucket) {
  if (!row) {
    return {
      available: false,
      granularity: bucket.granularity,
      bucketKey: bucket.bucketKey,
      periodStart: bucket.periodStart.toISOString(),
      periodEnd: bucket.periodEnd.toISOString(),
      isFrozen: false,
      summary: "",
      themes: [],
      moodTrajectory: {},
      changes: [],
      evidenceIds: [],
      updatedAt: null,
    };
  }
  const themes = parseJson<any[]>(row.themes_json, []);
  const changes = parseJson<any[]>(row.changes_json, []);
  return {
    available: Boolean(row.summary || themes.length || changes.length),
    granularity: row.granularity,
    bucketKey: row.bucket_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    isFrozen: bucketFrozen(row, "arc_frozen", "arc_evidence_ids_json"),
    summary: row.summary || "",
    themes,
    moodTrajectory: parseJson(row.mood_trajectory_json, {}),
    changes,
    evidenceIds: bucketEvidence(row, "arc_evidence_ids_json"),
    updatedAt: row.updated_at,
  };
}

export function getRetrospect(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey?: string | null,
) {
  const bucket = calendarBucketFromKey(granularity, bucketKey);
  const row = readBucket(scope, granularity, bucket.bucketKey);
  const streams = listStreamsBetween(scope, bucket.periodStart, bucket.periodEnd, 500);
  const timeline = readAffectTimeline(scope, 1200, "day");
  const startDay = dayKey(bucket.periodStart);
  const endDay = dayKey(bucket.periodEnd);
  // Retrospect shows both channels; voice samples only exist when a caller
  // supplied a real voice VAD triplet (no synthetic values are invented here).
  const affectTimeline = mergeAffectPoints([
    timeline.textTurnPoints || [],
    timeline.voiceTurnPoints || [],
  ]).filter((point) => {
    const period = String(point.period || "");
    return period >= startDay && period <= endDay;
  });
  return {
    portrait: getUserPortrait(scope),
    periodPortrait: periodPortraitPayload(row, bucket),
    arc: arcPayload(row, bucket),
    mirror: getMirror(scope),
    affectTimeline,
    streams: streams.map((stream) => ({
      id: stream.id,
      narrative: stream.narrative,
      about: stream.about,
      type: stream.type,
      createdAt: stream.created_at,
    })),
    recompute: null,
  };
}

export async function recomputeRetrospect(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey?: string | null,
) {
  const now = new Date();
  const periodPortrait = await ensurePeriodPortraitReady(scope, granularity, bucketKey, {
    force: true,
    now,
  });
  const portrait = await consolidateUserPortrait(scope);
  const arc = await ensureArcReady(scope, granularity, bucketKey, { force: true, now });
  return {
    ...getRetrospect(scope, granularity, bucketKey),
    recompute: { periodPortrait, portrait, arc },
  };
}

export async function ensurePeriodPortraitReady(
  scope: MemoryScope,
  granularity: CalendarGranularity,
  bucketKey?: string | null,
  options: { force?: boolean; now?: Date } = {},
) {
  return consolidatePeriodPortrait(scope, granularity, bucketKey, options);
}

export function listRetrospectBuckets(scope: MemoryScope, granularity: CalendarGranularity) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM hippocampus_retrospect_buckets
       WHERE agent_id = ? AND user_id = ? AND granularity = ?
       ORDER BY period_start DESC LIMIT 120`,
    )
    .all(scope.agentId, scope.userId, granularity) as BucketRow[];
  const items: Array<{
    granularity: string;
    bucketKey: string;
    periodStart: string;
    periodEnd: string;
    isFrozen: boolean;
    summary: string;
    available: boolean;
    updatedAt: string | null;
  }> = rows
    .filter((row) => row.summary || row.themes_json || row.changes_json)
    .map((row) => ({
      granularity: row.granularity,
      bucketKey: row.bucket_key,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      isFrozen: Boolean(row.is_frozen),
      summary: row.summary || "",
      available: Boolean(row.summary || parseJson<any[]>(row.themes_json, []).length || parseJson<any[]>(row.changes_json, []).length),
      updatedAt: row.updated_at,
    }));
  const current = currentCalendarBucket(granularity);
  if (!items.some((item) => item.bucketKey === current.bucketKey)) {
    items.unshift({
      granularity,
      bucketKey: current.bucketKey,
      periodStart: current.periodStart.toISOString(),
      periodEnd: current.periodEnd.toISOString(),
      isFrozen: false,
      summary: "",
      available: false,
      updatedAt: null,
    });
  }
  return { items, total: items.length };
}

const afterDigestTimers = new Map<string, NodeJS.Timeout>();
const afterDigestRunning = new Set<string>();

export function scheduleWitnessAfterDigest(scope: MemoryScope) {
  const key = `${scope.agentId}:${scope.userId}`;
  if (afterDigestTimers.has(key)) return;
  const timer = setTimeout(() => {
    afterDigestTimers.delete(key);
    if (afterDigestRunning.has(key)) return;
    afterDigestRunning.add(key);
    void (async () => {
      try {
        await consolidateUserPortrait(scope);
        await consolidatePeriodPortraitsAfterDigest(scope);
      } catch (error) {
        logTick(
          scope,
          "witness_portrait",
          "nothing",
          { reason: "background_failed" },
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        afterDigestRunning.delete(key);
      }
    })();
  }, 8000);
  timer.unref?.();
  afterDigestTimers.set(key, timer);
}

export function listTimeMirrorScopes(): MemoryScope[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT m.agent_id AS agentId, m.user_id AS userId
       FROM chat_messages m
       JOIN agent_configs a ON a.id = m.agent_id
       WHERE m.agent_id IS NOT NULL AND m.user_id IS NOT NULL
         AND a.time_mirror_enabled = 1`,
    )
    .all() as { agentId: number; userId: string }[];
  return rows.map((row) => ({ agentId: Number(row.agentId), userId: String(row.userId) }));
}

export function listImportRetrospectTargets(
  start: Date,
  end: Date,
): { granularity: CalendarGranularity; bucketKey: string }[] {
  const targets: { granularity: CalendarGranularity; bucketKey: string }[] = [];
  const seen = new Set<string>();
  const addRange = (granularity: CalendarGranularity) => {
    let cursor = new Date(start.getTime());
    while (cursor <= end) {
      const bucket = calendarBucketFromKey(granularity, undefined, cursor);
      const key = `${granularity}:${bucket.bucketKey}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ granularity, bucketKey: bucket.bucketKey });
      }
      cursor = new Date(bucket.periodEnd.getTime() + 1);
    }
  };
  addRange("week");
  addRange("month");
  addRange("quarter");
  addRange("year");
  return targets;
}
