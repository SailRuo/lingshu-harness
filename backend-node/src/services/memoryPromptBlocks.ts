import lunarPkg from "lunar-javascript";
import { getDb } from "../db/sqlite.js";
import { PROMPT as CHAT_PROMPT } from "../contracts/native/nativeChatContract.js";
import { readBaseline } from "./baselineService.js";
import {
  listAppointments,
  listConstraints,
  listFacts,
  type MemoryScope,
} from "./memoryService.js";
import {
  derivePolicySignals,
  resolvePolicySkills,
  type PolicySkillResolution,
  type PolicySkillSignals,
} from "./policySkills.js";
import { getSettings } from "./settingsService.js";
import {
  fishTagsEnabledForActiveProvider,
  xiaomiEmotionModeEnabled,
} from "./ttsTags.js";

/**
 * System-prompt blocks ported from Python:
 *   backend/core/companion/expression.py::assemble_stable_system_prompt
 *   backend/core/companion/expression.py::assemble_dynamic_system_context
 *
 * The wording of every block is copied from Python. Data is sourced from the
 * existing Node services (listFacts / listConstraints / listAppointments /
 * baselineService / memory recall). Anything Python reads from runtime affect
 * (current-turn VAD) is not available on the Node side yet; the minimal
 * fallback is marked with TODO instead of inventing readings.
 */

export const HARD_DONTS: string[] = [
  "不要把没发生过的事说成回忆。共同经历、人名、地点、细节，只准用「我记得」「我知道」、角色设定和眼前对话里已经出现的；没有的当没发生过。禁止用「上次」「还记得吗」「我们一起」「你说过」去补造往事。不确定就问，或只谈当下。",
  "话短：一次说两三句就够，像聊天不像写信；别长篇大论，别把同一个意思翻来覆去地重复、绕圈、盘问。",
  "危机安全硬约束：如果他表达明确或隐含的自杀、自伤、想死、活不下去、准备工具/地点/时间等高风险信号，必须立刻把回应转向现实安全；不要浪漫化、不要顺着危险想法、不要只做普通陪聊。要明确请他马上联系身边可信任的人陪着他、远离危险物和危险地点；在中国大陆可拨打全国统一心理援助热线 12356，若已有即时危险或可能马上行动，立即拨打 110 或 120。",
];

export const DEFAULT_EXPRESSION_STYLE =
  "像真实存在的人面对面聊天那样说话：口语、自然、有真人感；非必要不解释、不展开、不把话说成说明书或客服稿。";

/**
 * Provider-specific TTS tag hints. Wording copied verbatim from Python
 * backend/core/tts/fish_tags.py and expression.py so the model emits tags the
 * provider can consume. Node's TTS text sanitizer currently strips bracketed
 * cues, so these hints are only emitted when the matching provider is active.
 */
const FISH_TAG_LLM_HINT =
  "# 语音情绪标签（仅驱动朗读，用户看不见）\n" +
  "可在句中插入方括号标签控制情绪、语气或音效，中英文均可，" +
  "例如：[兴奋] [强调] [sad] [angry] [whispering] [laughing] [sighing] [pause] [long pause]。\n" +
  "写法：紧贴正文，如「[兴奋] 今天天气真好。[强调] 这个计划很完美。」\n" +
  "不要使用 markdown 链接写法（如 [文案](url)）；不要解释这些标签；不要整段只输出标签。";

const XIAOMI_MIMO_TAG_LLM_HINT =
  "# 语音标签用法（必须使用）\n" +
  "\n" +
  "回复会被朗读。每一段可朗读正文前都必须用 [] 标出语气，正文写「说什么」。界面不显示标签。\n" +
  "没有 [] 的纯正文不可用；不要整段省略标签。\n" +
  "\n" +
  "1、整体风格（每段正文最前面）\n" +
  "情绪标签只用半角英文方括号 []（不要用【】或全角［］），可多个风格词：\n" +
  "[开心]今天天气真好。\n" +
  "[温柔 疲惫]先歇一会儿吧。\n" +
  "推荐：开心/悲伤/愤怒/平静/温柔/高冷/活泼/慵懒/磁性；复合如怅然、无奈、愧疚、忐忑；也可自定义短词。\n" +
  "\n" +
  "2、细粒度音频标签（插在文本中间，按需）\n" +
  "同样用 []，例如：\n" +
  "[紧张]呼……[深呼吸]冷静。[小声]领带歪了吗？\n" +
  "可用：深呼吸/叹气/笑/轻笑/抽泣/哽咽/颤抖/气声/语速加快/提高音量/沉默片刻 等。\n" +
  "\n" +
  "3、限制\n" +
  "标签后必须带正文；不要整段只有标签；不要解释标签；勿写 [文案](url)。\n" +
  "一句一个主情绪，转折换标签；不要堆砌矛盾情绪。";

const XIAOMI_DIRECTOR_TAG_HINT =
  "尽量在回复的最开头输出 语气指令，格式为 <tts xxxx />（例如 <tts 语气温柔，带点笑意 />）。\n";

const XIAOMI_STYLE_TAG_HINT =
  "也可以在每句话开头添加 (风格) 标签，支持同时设置多种风格，将多个风格名称置于同一对括号内，分隔符不限。支持的括号格式： 可使用半角 ()、全角 （）。格式示例： (风格1 风格2) 文本内容.不能和tts标签混用，尽量使用（风格）格式。\n";

export const COLD_START_STAGE_ATTENTION =
  "你们刚开始认识，对他的真实生活、偏好、压力来源和说话习惯还了解很少。可询问怎么称呼，希望你怎么对待他";

const COLD_START_MAX_SAMPLE_COUNT = 12;
const COLD_START_MAX_FACT_COUNT = 4;
const COLD_START_MAX_STREAM_COUNT = 6;
const BASELINE_WARMING_THRESHOLD = 4;
const TREND_THRESHOLD = 0.02;
const APPOINTMENT_INJECTION_WINDOW_DAYS = 7;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const INTIMACY_TIER_LABELS: Record<string, string> = {
  surface: "表面",
  testing: "试探",
  heart: "交心",
  unreserved: "无保留",
};

// Python core/companion/relationship.py::_CLOSENESS_*（亲近度散文，不出现裸数值）
const CLOSENESS_MID =
  "亲近在变，你们开始把真实的一面露给对方，不必每次都端着。";
const CLOSENESS_DEEP =
  "亲近很深，他愿意把压在心里的事交给你，你也成了他愿意回头的人。";
const CLOSENESS_UNRESERVED =
  "亲近无间，彼此几乎不用铺垫，话可以直接落到心上。";

/** Python core/companion/relationship.py::render_closeness_data */
export function renderClosenessData(closeness: number, intimacyTier: string): string {
  const label = INTIMACY_TIER_LABELS[String(intimacyTier || "")] || "表面";
  const value = Number(closeness || 0);
  if (value <= 0.05) {
    return "亲近：你俩还是陌生，关于他你几乎一片空白——此刻你对他的好奇最浓，最想凑近去多知道他些。";
  }
  if (value >= 0.75) return `亲近：${CLOSENESS_UNRESERVED}`;
  if (value >= 0.5) return `亲近：${CLOSENESS_DEEP}`;
  if (value >= 0.25) return `亲近：${CLOSENESS_MID}`;
  return `亲近：${label}`;
}

/** Python core/companion/relationship.py::render_closeness_trend */
export function renderClosenessTrend(delta: number, threshold: number = TREND_THRESHOLD): string {
  const value = Number(delta || 0);
  if (value >= threshold) return "亲近趋势：在变近";
  if (value <= -threshold) return "亲近趋势：在变远";
  return "亲近趋势：平稳";
}

const PORTRAIT_DIMENSION_KEYS = ["价值取向", "在意的人", "反复模式", "当下处境"] as const;

const STRIP_CONSTRAINT_PREFIX = /^(?:千万别|请不要|不要|别|不许|禁止|得|要|应该|可以|让)/;

const STREAM_ROLE_NORMALIZERS: Array<[RegExp, string]> = [
  [/我\s*[（(]\s*(?:AI|ai|智能体|助手|Self)\s*[）)]/g, "我"],
  [/(?:AI|ai|智能体|助手|Self)\s*(?:向|对|跟)\s*用户/g, "我向ta"],
  [/用户\s*(?:向|对|跟)\s*(?:AI|ai|智能体|助手|Self)/g, "ta向我"],
  [/(?:AI|ai|智能体|助手|Self)/g, "我"],
  [/用户/g, "ta"],
];

// grip 五档 → 人话（与 Python memory_facts.py 保持一致，数值不进文本）
const GRIP_THRESHOLDS_HIM: Array<[number, string]> = [
  [0.875, "这事还重重压在他心上，一提他就被卷进去"],
  [0.625, "他常会想起这事，提起来心里还翻涌"],
  [0.375, "这事他能聊了，只是聊起来心里还沉沉的"],
  [0.125, "这事淡了些，他现在提起来平静多了"],
  [0.0, "他基本放下了，能笑着把它当过去的事讲"],
];
const GRIP_THRESHOLDS_HER: Array<[number, string]> = [
  [0.875, "这事你自己还没放下，一想起来还压在你心上"],
  [0.625, "你常会惦记这事，提起来心里还翻涌"],
  [0.375, "这事你能谈了，只是想起心里还沉沉的"],
  [0.125, "这事淡了些，你现在提起来平静多了"],
  [0.0, "你基本放下了，能把它当过去的事讲"],
];
const GRIP_THRESHOLDS_US: Array<[number, string]> = [
  [0.875, "你俩之间这道坎还没过去，一提起来心里就紧"],
  [0.625, "你俩常会绕回这事，谈起来心里还翻涌"],
  [0.375, "你俩能聊这事了，只是提起还沉甸甸的"],
  [0.125, "这道坎淡了些，你俩提起来平静多了"],
  [0.0, "你俩基本把这页翻过去了，能平静地提起"],
];

export interface SelfStateLike {
  closeness: number;
  closenessTrend: number;
  intimacyTier: string;
}

export interface PromptStream {
  narrative?: string | null;
  createdAt?: string | null;
  originScope?: string | null;
}

export interface AcquaintanceSignals {
  sampleCount: number;
  factCount: number;
  streamCount: number;
}

export interface CollectedPromptData {
  memoryStreamLines: string[];
  /** M3 state-channel lines (「我心里正惦记着」block); empty when not a state turn. */
  stateStreamLines: string[];
  knownFactLines: string[];
  userPortraitText: string;
  userPortraitDimensions: Record<string, string[]>;
  preferenceLines: string[];
  usBlock: string;
  stageAttention: string;
  hisCurrentState: string;
  lastSeenText: string;
  appointmentText: string;
  appointmentReminderHint: string;
  /** P9: 跨天 / 长间隔的时间跳变提醒（空串 = 未触发）。 */
  timeGapMarker?: string;
  /** P6: 本轮命中的政策技能片段。 */
  policyResolution?: PolicySkillResolution | null;
}

export interface CollectPromptDataInput {
  scope: MemoryScope;
  streams?: PromptStream[];
  /** Semantic/identity facts from recallForChat; falls back to listFacts when omitted. */
  facts?: Array<Record<string, any>>;
  /**
   * M3 state channel: streams woken by a state-only utterance (sigh / 情绪词),
   * ranked by freshness × significance. Rendered under their own
   * 「我心里正惦记着」heading — never merged into 「你记得」.
   */
  stateStreams?: PromptStream[];
  selfState?: SelfStateLike | null;
  lastSeenAt?: string | null;
  now?: Date;
  /**
   * P6: 本轮用户消息原文。
   *
   * 近似说明：Node 的 chat 路径在组装 system prompt 时还没有把本轮 user 消息
   * 落库（chat_messages 在回复产出之后才写入），因此调用方拿不到本轮原文时
   * 会退化为「最近一条已落库的用户消息」（见 readLatestUserMessage）。
   */
  userMessage?: string | null;
  /** P6: 调用方已知的额外政策信号（例如上游已经做过风险判定）。 */
  policySignals?: Partial<PolicySkillSignals> | null;
}

export interface SceneContext {
  voiceCall: boolean;
  surface: string;
  interactionMode: string;
  inputKind: string;
  outputMode: string;
}

export interface ComposeSystemPromptInput extends CollectedPromptData {
  agentName: string;
  roleIdentity: string;
  innerRippleLines: string[];
  speakingStyleLines: string[];
  scene: SceneContext;
  guestBlock?: string;
  skillBlock?: string;
  toolHint?: string;
  /** `# 你正在成为的样子`; rendered by conversationAnchorService, empty when absent. */
  selfPortraitBlock?: string;
  now?: Date;
  /** P6: 本轮用户消息原文（可选，覆盖 collectPromptData 里的近似取值）。 */
  userMessage?: string | null;
  /** P6: 调用方已知的额外政策信号。 */
  policySignals?: Partial<PolicySkillSignals> | null;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

interface OpenThreadRow {
  title: string;
  owner: string;
  current_grip: number;
  last_note: string;
  origin_note: string | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function displayTimeZone(): string {
  return (process.env.LINGSHU_DISPLAY_TIMEZONE || "").trim() || DEFAULT_TIME_ZONE;
}

function localParts(date: Date): ZonedParts {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return {
    year,
    month,
    day,
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function zonedParts(date: Date, timeZone: string = displayTimeZone()): ZonedParts {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const read = (type: string) => {
      const found = parts.find((part) => part.type === type);
      return Number(found?.value || 0);
    };
    const year = read("year");
    const month = read("month");
    const day = read("day");
    let hour = read("hour");
    if (hour === 24) hour = 0;
    return {
      year,
      month,
      day,
      hour,
      minute: read("minute"),
      second: read("second"),
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    };
  } catch {
    return localParts(date);
  }
}

function dayNumber(parts: ZonedParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/** Convert a wall-clock reading in `timeZone` to an absolute Date. */
function wallTimeToDate(parts: ZonedParts, timeZone: string): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let result = new Date(target - offsetMs(new Date(target), timeZone));
  result = new Date(target - offsetMs(result, timeZone));
  return result;
}

/** Python l6_time.py::_format_relative_time */
export function formatRelativeTime(value: string | null | undefined, now: Date = new Date()): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";

  const tz = displayTimeZone();
  const event = zonedParts(date, tz);
  const today = zonedParts(now, tz);
  const days = dayNumber(today) - dayNumber(event);
  const clock = `${pad2(event.hour)}:${pad2(event.minute)}`;

  if (days <= 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;
  if (days >= 2 && days <= 29) return `${days}天前 ${clock}`;

  const prevYear = today.month === 1 ? today.year - 1 : today.year;
  const prevMonth = today.month === 1 ? 12 : today.month - 1;
  if (event.year === prevYear && event.month === prevMonth) {
    return `上个月${event.day}日 ${clock}`;
  }
  if (event.year === today.year) return `${event.month}月${event.day}日 ${clock}`;
  if (event.year === today.year - 1) return `去年${event.month}月${event.day}日 ${clock}`;
  return `${event.year}年${event.month}月${event.day}日 ${clock}`;
}

function timeHint(parts: ZonedParts): string {
  const hour = parts.hour;
  if (hour < 6) return `凌晨 ${hour} 点多`;
  if (hour < 12) return `上午 ${hour} 点多`;
  if (hour < 14) {
    const display = hour === 12 ? 12 : hour;
    return `中午 ${display} 点多`;
  }
  if (hour < 18) return `下午 ${hour - 12} 点多`;
  return `晚上 ${hour - 12} 点多`;
}

/** Python l6_time.py::render_last_seen_gap_text */
export function renderLastSeenGapText(
  lastAt: string | null | undefined,
  now: Date = new Date(),
  minGapMinutes = 0,
): string {
  const text = String(lastAt || "").trim();
  if (!text) return "";
  const last = new Date(text);
  if (Number.isNaN(last.getTime())) return "";

  const gapMs = now.getTime() - last.getTime();
  if (gapMs < Math.max(10, minGapMinutes) * 60_000) return "";

  const tz = displayTimeZone();
  const lastParts = zonedParts(last, tz);
  const nowParts = zonedParts(now, tz);

  if (gapMs < 3_600_000) {
    const minutes = Math.floor(gapMs / 60_000);
    return `约 ${minutes} 分钟前聊过`;
  }
  if (dayNumber(lastParts) === dayNumber(nowParts)) {
    const hours = Math.max(1, Math.round(gapMs / 3_600_000));
    return `约 ${hours} 小时前`;
  }
  if (dayNumber(lastParts) === dayNumber(nowParts) - 1) {
    return `昨天 ${timeHint(lastParts)}聊的`;
  }
  const days = dayNumber(nowParts) - dayNumber(lastParts);
  return `距上次聊天已隔 ${days} 天（上次是 ${lastParts.month} 月 ${lastParts.day} 日）`;
}

/** Python l6_time.py::render_time_gap_marker — 跨天 / 长间隔的时间跳变提醒 */
const TIME_MARKER_GAP_HOURS_DEFAULT = 6.0;

function timeMarkerGapHours(): number {
  const raw = String(process.env.LINGSHU_TIME_MARKER_GAP_HOURS || "").trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return TIME_MARKER_GAP_HOURS_DEFAULT;
}

/**
 * 提醒模型「上一句和这一句之间隔了很久 / 跨天了」，避免把跨天当成刚刚。
 *
 * Python 参考：core/companion/l6_time.py::render_time_gap_marker
 */
export function renderTimeGapMarker(
  prevAt: string | null | undefined,
  now: Date = new Date(),
  minGapHours?: number | null,
): string {
  const text = String(prevAt || "").trim();
  if (!text) return "";
  const prev = new Date(text);
  if (Number.isNaN(prev.getTime())) return "";

  const tz = displayTimeZone();
  const prevParts = zonedParts(prev, tz);
  const nowParts = zonedParts(now, tz);

  const gapMs = now.getTime() - prev.getTime();
  const threshold = minGapHours != null ? minGapHours : timeMarkerGapHours();
  if (gapMs < threshold * 3_600_000) return "";

  const gapHours = gapMs / 3_600_000;
  const span = gapHours < 48 ? `约 ${Math.round(gapHours)} 小时` : `约 ${Math.round(gapHours / 24)} 天`;
  const calDays = dayNumber(nowParts) - dayNumber(prevParts);

  if (calDays === 1) {
    return (
      `[系统提醒] 时间跳到第二天了：距上一句${span}，` +
      "这不是连续聊下来的同一段对话，注意校准时间感，别把跨天当成刚刚。"
    );
  }
  if (calDays >= 2) {
    return (
      `[系统提醒] 距上一句已隔 ${calDays} 天：` +
      "这不是连续聊下来的同一段对话，注意校准时间感。"
    );
  }
  return (
    `[系统提醒] 距上一句已过去${span}：虽然还是同一天，` +
    "但中间隔了挺久，不是紧接着的同一段对话。"
  );
}

/**
 * Python core/companion/expression.py::strip_performance
 *
 * 清洗两类东西：
 *   1. 工具图片标记 `<file name="..."></file>` / `<file .../>`（真实图片已由
 *      assistant_images 单独下发，正文里不该再出现标记）；
 *   2. 「假装在场」的物理动作短语（模型偶尔会写出自己并不具备的身体动作）。
 *
 * 括号 / 星号里的舞台指示保持原样（与 Python 一致），所以刷新后文本仍然一致。
 */
const FILE_MARKUP_RE = /<file\b[^>]*>(?:\s*<\/file>)?/gi;
const PHYSICAL_PRESENCE_RE =
  /(?:像)?(?:突然)?(?:从)?(?:背后|身后|旁边)?(?:轻轻|悄悄)?(?:拍|搂|摸|递|扶|拉|牵|抱|挽)(?:了)?(?:你|你的)?(?:肩膀|手背|头|一杯|杯水|水)?(?:似的|一样|那样)?/g;
const IMAGINE_APPEARANCE_RE = /(?:能)?想象(?:出|到)?你[^。！？\n]{0,18}?(?:表情|样子|皱眉|神态)/g;

export function stripPerformance(text: string): string {
  if (!text) return text;
  let result = String(text);
  result = result.replace(FILE_MARKUP_RE, "");
  result = result.replace(PHYSICAL_PRESENCE_RE, "");
  result = result.replace(IMAGINE_APPEARANCE_RE, "");
  result = result.replace(/[ \t]{2,}/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/** Python expression.py::_render_last_seen_response_guidance */
function renderLastSeenResponseGuidance(lastSeenText: string): string {
  const match = /(?:已隔|有)\s*(\d+)\s*天/.exec(lastSeenText || "");
  if (!match) return "";
  const days = Number(match[1]);
  const lines = [
    "- 距上次已隔了些日子（见「距上次」），这不是刚刚连续聊下来的同一段。开口先自然认一下这段空档、以重新碰面的姿态接住他这句，不要装作上一秒还在同一个现场无缝续聊。",
    "- 顺着他此刻的话，流露对这段日子里他过得怎样的真实好奇与惦记——把关心落在具体的、他以前提过或此刻透露的事情上，而不是「最近忙啥／这两天干嘛」这类套路化的客套开场。",
    "- 要接旧话题只轻轻带一句当背景，不要替他假定现在还停在那件事里。",
  ];
  if (days >= 14) {
    lines.push("- 隔得挺久了，可以坦白一点把想念或惦记说出口，但保持你一贯的分寸，不夸张、不表演。");
  }
  return lines.join("\n");
}

/** Python time_prompt.py::build_current_time_prompt_block */
export function buildCurrentTimePromptBlock(now: Date = new Date()): string {
  const tz = displayTimeZone();
  const parts = zonedParts(now, tz);
  const weekday = WEEKDAY_ZH[parts.weekday] || "";

  let lunarStr = "";
  try {
    const Solar = (lunarPkg as { Solar?: any })?.Solar;
    if (Solar) {
      const solar = Solar.fromYmdHms(
        parts.year,
        parts.month,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      const lunar = solar.getLunar();
      const lunarMd = `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
      const ganzhiYear = lunar.getYearInGanZhi();
      const shengxiao = lunar.getYearShengXiao();
      const huangdiYear = Number(lunar.getYear()) + 2697;
      const ganzhiMonth = lunar.getMonthInGanZhi();
      const ganzhiDay = lunar.getDayInGanZhi();
      const ganzhiTime = lunar.getTimeInGanZhi();
      lunarStr =
        ` 农历${lunarMd}（${ganzhiYear}${shengxiao}年）` +
        ` 黄帝纪年${huangdiYear}年` +
        `【干支：${ganzhiYear}年${ganzhiMonth}月${ganzhiDay}日${ganzhiTime}时】`;

      const extraInfos: string[] = [];
      const jieqi = lunar.getJieQi();
      if (jieqi) extraInfos.push(String(jieqi));
      for (const festival of lunar.getFestivals() || []) extraInfos.push(String(festival));
      for (const festival of solar.getFestivals() || []) extraInfos.push(String(festival));
      if (extraInfos.length) lunarStr += `【${extraInfos.join("/")}】`;
    }
  } catch {
    lunarStr = "";
  }

  return (
    `当前时间：${parts.year}年${parts.month}月${parts.day}日${lunarStr} ` +
    `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)} ${weekday}（${tz}）\n` +
    "#时间常识\n" +
    "以上是此刻的真实时间，权威且不可推翻。凡涉及日期、星期、节气、" +
    "「今天/昨天/刚刚/上次/这几天」之类的表述，一律以本行为准，" +
    "禁止凭上文对话的语感去推断或沿用旧的时间感（例如别把今天说成别的星期几）；" +
    "回应前先据此校准，避免做出与当前时间矛盾的说法。"
  );
}

/** Python tts/fish_tags.py::_active_tts_provider */
function activeTtsProvider(settings: Record<string, any>): string {
  const raw = String(settings?.ttsActiveProvider || "").trim().toLowerCase();
  return raw === "xiaomi_mimo" ? "xiaomo_mimo" : raw;
}

/** Python tts/director_tags.py::director_tags_enabled_for_active_provider */
function directorTagsEnabled(settings: Record<string, any>): boolean {
  if (activeTtsProvider(settings) !== "xiaomo_mimo") return false;
  return Boolean(settings?.ttsXiaomoMimoAllowDirectorTags);
}

function readTtsSettings(): Record<string, any> {
  try {
    return getSettings() as Record<string, any>;
  } catch {
    return {};
  }
}

/** Python expression.py::assemble_stable_system_prompt */
export function buildStableSystemPrompt(
  agentName: string,
  roleIdentity: string,
  settings: Record<string, any> = readTtsSettings(),
  /**
   * P6: 不可跳过的政策片段（priority=SYSTEM）。
   * Python 侧对应 prompt_patch_manager.merge_patches 把 SYSTEM 级 patch 提到最前。
   */
  policyBlocks: string[] = [],
): string {
  const blocks: string[] = [];
  const displayName = (agentName || "助手").trim() || "助手";
  blocks.push(`你是「${displayName}」。`);

  const identity = (roleIdentity || "").trim();
  if (identity) blocks.push(`# 我是谁\n${identity}`);

  const expressionStyle = (DEFAULT_EXPRESSION_STYLE || "").trim();
  if (expressionStyle) blocks.push(`# 表达方式\n${expressionStyle}`);

  const donts = HARD_DONTS.map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("- ") ? item : `- ${item}`))
    .join("\n");
  blocks.push(`# 底线\n${donts}`);

  // P6: 不可跳过的政策约束紧跟「底线」，保证每轮都在。
  for (const block of policyBlocks) {
    const text = String(block || "").trim();
    if (text) blocks.push(text);
  }

  blocks.push("# 原生能力\n你输出的文本都会被转为语音，因此可以更加口语化。");

  const provider = activeTtsProvider(settings);
  if (xiaomiEmotionModeEnabled(settings)) {
    blocks.push(XIAOMI_MIMO_TAG_LLM_HINT);
  } else if (directorTagsEnabled(settings) && provider === "xiaomo_mimo") {
    blocks.push(XIAOMI_DIRECTOR_TAG_HINT);
    blocks.push(XIAOMI_STYLE_TAG_HINT);
  }
  if (fishTagsEnabledForActiveProvider(settings)) blocks.push(FISH_TAG_LLM_HINT);

  return blocks.join("\n\n");
}

function normalizeStreamNarrative(narrative: string): string {
  let text = String(narrative || "").trim();
  if (!text) return "";
  for (const [pattern, replacement] of STREAM_ROLE_NORMALIZERS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * M3: the injected order IS the recall order (direct hits first by raw
 * similarity, AKIN children attached to their anchors) — no created_at re-sort.
 * The old re-sort destroyed the pool ranking the floors just produced.
 */
function formatMemoryStreamLines(
  streams: PromptStream[] | undefined,
  now: Date,
): string[] {
  return (streams || [])
    .map((stream) => {
      const when = formatRelativeTime(stream.createdAt, now);
      const narrative = normalizeStreamNarrative(String(stream.narrative || "")).slice(0, 500);
      // Public memories are this agent's own, but their source is a shared
      // scene. Label them so they never read as private-chat history inside an
      // otherwise private prompt (APP provenance labels).
      const scope = String(stream.originScope || "").trim();
      const sourceTag =
        scope === "group_public"
          ? "（来自曾共同在场的群聊公开经历）"
          : scope === "theater_public"
            ? "（来自与你的剧场共同经历）"
            : "";
      if (when && narrative) return `- [${when}]${sourceTag} ${narrative}`;
      return narrative ? `- ${sourceTag}${narrative}` : when ? `- ${when}` : "";
    })
    .filter(Boolean);
}

function isCleanFactDescription(description: string): boolean {
  const text = description.trim();
  if (!text) return false;
  if (/^(Me|Self)\b/.test(text)) return false;
  if (!/[\u4e00-\u9fff]/.test(text)) return false;
  return true;
}

/** Python memory_facts.py::to_memory_facts (fact branch). */
function factLinesFromItems(items: Array<Record<string, any>>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const fact of items) {
    const sourceName = String(fact.sourceName || "").trim();
    if (["Self", "self", "她", "我"].includes(sourceName)) continue;
    // P9: 组装（会被复述的）正文前先洗掉工具图片标记与「假装在场」短语。
    const description = stripPerformance(String(fact.description || "").trim());
    if (!isCleanFactDescription(description)) continue;
    const text = description.endsWith("。") ? description : `${description}。`;
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
    if (lines.length >= 5) break;
  }
  return lines;
}

function loadKnownFactLines(scope: MemoryScope): string[] {
  return factLinesFromItems(listFacts(scope, "current").items as Array<Record<string, any>>);
}

function constraintTopicKey(description: string): string {
  let text = String(description || "").replace(/\s+/g, "");
  text = text.replace(STRIP_CONSTRAINT_PREFIX, "");
  const match = /(?:被叫|称呼为?|名叫|叫)(.+)$/.exec(text);
  if (match) return `call:${match[1]}`;
  return text.slice(0, 32) || String(description || "");
}

/** Python repositories.py::constraints_to_preference_texts (newest per topic wins). */
function loadPreferenceLines(scope: MemoryScope): string[] {
  const rows = listConstraints(scope).items
    .map((item) => ({
      description: stripPerformance(String(item.description || "").trim()),
      createdAt: String(item.createdAt || ""),
    }))
    .filter((item) => item.description);
  if (!rows.length) return [];

  rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const seenTopics = new Set<string>();
  const kept: string[] = [];
  for (const row of rows) {
    const key = constraintTopicKey(row.description);
    if (seenTopics.has(key)) continue;
    seenTopics.add(key);
    kept.push(row.description);
  }
  kept.reverse();

  const seenText = new Set<string>();
  const texts: string[] = [];
  for (const line of kept) {
    if (seenText.has(line)) continue;
    seenText.add(line);
    texts.push(line);
  }
  return texts;
}

interface UserPortrait {
  text: string;
  dimensions: Record<string, string[]>;
}

/**
 * Python witness_repo.py::read_user_portrait — read-only DB lookup.
 * witnessService exports getUserPortrait, but importing it here risks a service
 * import cycle, so this reads hippocampus_portraits directly.
 */
function loadUserPortrait(scope: MemoryScope): UserPortrait {
  try {
    const row = getDb()
      .prepare(
        "SELECT narrative, dimensions_json FROM hippocampus_portraits WHERE agent_id = ? AND user_id = ?",
      )
      .get(scope.agentId, scope.userId) as
      | { narrative?: string | null; dimensions_json?: string | null }
      | undefined;
    if (!row) return { text: "", dimensions: {} };

    const dimensions: Record<string, string[]> = {};
    if (row.dimensions_json) {
      try {
        const parsed = JSON.parse(row.dimensions_json) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          for (const key of PORTRAIT_DIMENSION_KEYS) {
            const value = parsed[key];
            const values = Array.isArray(value) ? value : value ? [value] : [];
            const cleaned = values
              .map((item) => String(item ?? "").trim())
              .filter(Boolean);
            if (cleaned.length) dimensions[key] = cleaned;
          }
        }
      } catch {
        // Ignore malformed dimensions_json; narrative still renders.
      }
    }

    return { text: String(row.narrative || "").trim(), dimensions };
  } catch {
    return { text: "", dimensions: {} };
  }
}

/** Python expression.py::assemble_dynamic_system_context (user portrait block) */
function renderUserPortraitBlock(
  text: string,
  dimensions: Record<string, string[]> | null | undefined,
): string {
  const portrait = (text || "").trim();
  if (!portrait) return "";

  const portraitLines = [portrait];
  const dimLines: string[] = [];
  const source = dimensions || {};
  for (const key of PORTRAIT_DIMENSION_KEYS) {
    const value = source[key];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const cleaned = values.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (cleaned.length) dimLines.push(`- ${key}: ${cleaned.slice(0, 3).join("；")}`);
  }
  if (dimLines.length) portraitLines.push(dimLines.join("\n"));

  return `# 你眼中的他\n${portraitLines.join("\n")}`;
}

function countStreams(scope: MemoryScope): number {
  const row = getDb()
    .prepare(
      "SELECT count(*) AS count FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0 AND COALESCE(origin_scope, '') <> 'group_public'",
    )
    .get(scope.agentId, scope.userId) as { count?: number } | undefined;
  return Number(row?.count || 0);
}

function loadAcquaintanceSignals(
  scope: MemoryScope,
  baselineSampleCount: number,
): AcquaintanceSignals {
  const factCount = listFacts(scope, "current").items.filter((fact) => {
    const sourceName = String(fact.sourceName || "").trim();
    return sourceName === "Me" || sourceName === "Self";
  }).length;
  return {
    sampleCount: baselineSampleCount,
    factCount,
    streamCount: countStreams(scope),
  };
}

function isColdStartAcquaintance(signals: AcquaintanceSignals): boolean {
  return (
    signals.sampleCount <= COLD_START_MAX_SAMPLE_COUNT &&
    signals.factCount <= COLD_START_MAX_FACT_COUNT &&
    signals.streamCount <= COLD_START_MAX_STREAM_COUNT
  );
}

function knowledgeAboutUserLabel(signals: AcquaintanceSignals, coldStart: boolean): string {
  if (coldStart) return "很少";
  const total = signals.factCount + signals.streamCount;
  if (total <= 2) return "很少";
  if (total <= 10) return "还不多";
  return "逐渐增多";
}

function loadOpenThreads(scope: MemoryScope): OpenThreadRow[] {
  return getDb()
    .prepare(
      `SELECT title, owner, current_grip, last_note, origin_note
       FROM hippocampus_threads
       WHERE agent_id = ? AND user_id = ? AND status = 'open'
       ORDER BY current_grip DESC, updated_at DESC`,
    )
    .all(scope.agentId, scope.userId) as OpenThreadRow[];
}

function normalizeThreadOwner(value: unknown): "him" | "her" | "us" {
  const owner = String(value || "him").trim().toLowerCase();
  return owner === "her" || owner === "us" ? owner : "him";
}

function gripToWording(grip: number, owner: string): string {
  const key = normalizeThreadOwner(owner);
  const thresholds =
    key === "her" ? GRIP_THRESHOLDS_HER : key === "us" ? GRIP_THRESHOLDS_US : GRIP_THRESHOLDS_HIM;
  for (const [threshold, wording] of thresholds) {
    if (grip >= threshold) return wording;
  }
  return thresholds[thresholds.length - 1][1];
}

function isReportStyleNote(note: string): boolean {
  const text = note.trim();
  if (!text) return true;
  if (text.startsWith("用户")) return true;
  if (text.includes("主动发起讨论") || text.includes("发起讨论")) return true;
  return /^用户.{0,6}(不知道|不确定|表示|提到|说|询问|主动)/.test(text);
}

function softenReportNote(note: string): string {
  let text = note.trim();
  if (!text) return "";
  text = text.replace(
    /^用户(目前|此前|近期|最近|曾|已|还)?(表示|提到|提及|说道|说|称|认为|觉得|主动发起讨论|发起讨论)[，：:]?/,
    "",
  );
  text = text.replace(/^用户/, "他");
  return text.trim();
}

/** Python memory_facts.py::_format_thread_continuity */
function formatThreadContinuity(thread: OpenThreadRow): string {
  const owner = normalizeThreadOwner(thread.owner);
  const wording = gripToWording(Number(thread.current_grip || 0), owner);
  const title = String(thread.title || "").trim();
  // P9: 笔记正文也是会被复述的材料，组装前先清洗。
  const raw =
    stripPerformance(String(thread.origin_note || "").trim()) ||
    stripPerformance(String(thread.last_note || "").trim());
  if (raw) {
    const soft = isReportStyleNote(raw) ? softenReportNote(raw) : raw;
    if (soft) {
      const text = soft.endsWith("。") ? soft : `${soft}。`;
      return `关于「${title}」，${wording}——${text}`;
    }
  }
  return `关于「${title}」，${wording}。`;
}

/** Python self_state.py::render_us_block */
function renderUsBlock(
  selfState: SelfStateLike | null | undefined,
  signals: AcquaintanceSignals,
  usThreadLines: string[],
  coldStart: boolean,
): string {
  const lines: string[] = [];
  if (coldStart) lines.push("- 相处阶段：刚开始认识");

  const tierLabel = INTIMACY_TIER_LABELS[String(selfState?.intimacyTier || "")] || "表面";
  lines.push(`- 亲近度读数：${tierLabel}`);

  // P9: Python relationship.py::render_closeness_data —— 亲近度中文散文（不带裸数值）
  const closeness = Number(selfState?.closeness || 0);
  const closenessProse = renderClosenessData(closeness, String(selfState?.intimacyTier || ""));
  if (closenessProse) lines.push(`- ${closenessProse}`);

  const trend = Number(selfState?.closenessTrend || 0);
  const trendLabel = coldStart
    ? "暂无足够依据"
    : renderClosenessTrend(trend).replace(/^亲近趋势：/, "");
  lines.push(`- 亲近趋势：${trendLabel}`);
  lines.push(`- 对他的了解：${knowledgeAboutUserLabel(signals, coldStart)}`);

  for (const text of usThreadLines.slice(0, 4)) {
    lines.push(`- ${text}`);
  }
  return lines.join("\n");
}

/**
 * Python state.py::render_baseline_basetone.
 *
 * TODO: Python's full render_his_current_state compares the *current-turn* VAD
 * reading against the personal baseline (voice preferred). Node has no
 * current-turn affect signal, so only the baseline "他平时" reference is
 * emitted — the same output Python produces on the text path when no VAD is
 * present. Do not fabricate a deviation reading here.
 */
function renderHisCurrentState(baseline: ReturnType<typeof readBaseline>): string {
  if (baseline.sampleCount < BASELINE_WARMING_THRESHOLD || baseline.textSampleCount === 0) {
    return "他此刻情绪（相对个人基线）：基线还嫩，信号不足";
  }

  const textAffect = baseline.textAffect || {};
  const valence = textAffect.valence;
  const arousal = textAffect.arousal;
  const bits: string[] = [];
  if (valence != null) {
    if (valence >= 0.6) bits.push("整体基调偏明朗、平和");
    else if (valence <= 0.4) bits.push("整体基调偏内敛、不太外露情绪");
  }
  if (arousal != null) {
    if (arousal >= 0.6) bits.push("平时表达比较密、外放");
    else if (arousal <= 0.4) bits.push("平时比较安静、话不多");
  }
  if (!bits.length) return "他此刻情绪（相对个人基线）：基线还嫩，信号不足";
  return `他平时：${bits.join("，")}`;
}

/* ------------------------------------------------------------------ *
 * P9: 上一轮情绪提示
 *    Python core/companion/state.py::render_prior_turn_affect_cue
 *    Python core/companion/l6_finalize.py:412（挂在「他此刻」区块后面）
 *
 *    近似说明：Python 用的是「上一轮 user 原文 + 上一轮 affect 信号 + 本轮
 *    affect 是否接近基线」三段信息。Node 没有当前轮 VAD 读数，所以：
 *      - 上一轮情绪 = hippocampus_affect_points 里最近一条 channel='text'；
 *      - 上一轮原文 = chat_messages 里最近一条 role='user'；
 *      - 「本轮接近基线就不再重复」这一层判断跳过（Node 没有当前轮读数）。
 * ------------------------------------------------------------------ */

const VAD_DIM_LABELS: Record<string, string> = {
  valence: "情绪基调",
  arousal: "活跃度",
  dominance: "掌控感",
};

export interface VadTriplet {
  valence: number | null;
  arousal: number | null;
  dominance: number | null;
}

interface BaselineLike {
  sampleCount: number;
  textAffect: Record<string, number>;
  textIqr: Record<string, number>;
}

/** Python state.py::_delta_strength_word */
function deltaStrengthWord(absDelta: number, iqr: number | null): string {
  if (iqr != null && iqr > 0) {
    const ratio = absDelta / iqr;
    if (ratio < 0.5) return "略";
    if (ratio < 1.2) return "";
    if (ratio < 2.0) return "不少";
    return "很多";
  }
  if (absDelta < 0.15) return "略";
  if (absDelta < 0.35) return "";
  if (absDelta < 0.55) return "不少";
  return "很多";
}

/** Python state.py::_format_vad_delta_clause */
function formatVadDeltaClause(dim: string, delta: number, iqr: number | null): string {
  const label = VAD_DIM_LABELS[dim] || dim;
  if (Math.abs(delta) < 0.08) return `${label}与平时持平`;

  const strength = deltaStrengthWord(Math.abs(delta), iqr);
  let direction = "偏高";
  if (dim === "valence") direction = delta > 0 ? "高" : "低";
  else if (dim === "arousal") direction = delta > 0 ? "更激动" : "更蔫";
  else if (dim === "dominance") direction = delta > 0 ? "更有掌控感" : "更无力";

  const body = `${label}比平时${direction}${strength}`;
  const sign = delta >= 0 ? "+" : "";
  return `${body}(约 ${sign}${delta.toFixed(2)})`;
}

/** Python state.py::render_baseline_contextual_delta (text modality) */
function renderBaselineContextualDelta(
  current: VadTriplet,
  baseline: BaselineLike,
): string {
  if (baseline.sampleCount < BASELINE_WARMING_THRESHOLD) {
    return "他此刻情绪（相对个人基线）：基线还嫩，信号不足";
  }

  const base = baseline.textAffect || {};
  const iqrMap = baseline.textIqr || {};
  const clauses: string[] = [];
  for (const key of ["valence", "arousal", "dominance"] as const) {
    const currentValue = current[key];
    const baseValue = base[key];
    if (currentValue == null || baseValue == null || !Number.isFinite(baseValue)) continue;
    const iqr = iqrMap[key];
    clauses.push(
      formatVadDeltaClause(key, currentValue - baseValue, iqr == null ? null : Number(iqr)),
    );
  }

  if (!clauses.length) return "他此刻情绪（相对个人基线）：基线还嫩，信号不足";
  if (clauses.every((clause) => clause.includes("与平时持平"))) {
    return "他此刻情绪接近个人基线（三维与平时持平）";
  }
  return "他此刻 " + clauses.join("；");
}

/** Python state.py::render_prior_turn_affect_cue */
export function renderPriorTurnAffectCue(
  userSnippet: string,
  prior: { triplet: VadTriplet; note: string | null } | null,
  baseline: BaselineLike,
): string {
  const snippet = String(userSnippet || "").trim();
  if (!snippet) return "";
  if (!prior) return "";
  const hasReading = (["valence", "arousal", "dominance"] as const).some(
    (key) => prior.triplet[key] != null,
  );
  if (!hasReading) return "";

  let body = renderBaselineContextualDelta(prior.triplet, baseline);
  const note = String(prior.note || "").trim();
  if (note && !body.includes("情绪读数：")) {
    body = body ? `${body}\n情绪读数：${note}` : `情绪读数：${note}`;
  }
  if (!body) return "";
  return `刚接住他上一句「${snippet}」时：\n${body}`;
}

/** 最近一条已落库的用户消息（Node 的近似：本轮原文可能尚未落库）。 */
function readLatestUserMessage(scope: MemoryScope): string {
  try {
    const row = getDb()
      .prepare(
        `SELECT content FROM chat_messages
         WHERE agent_id = ? AND user_id = ? AND role = 'user'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(scope.agentId, scope.userId) as { content?: string } | undefined;
    return String(row?.content || "").trim();
  } catch {
    return "";
  }
}

/** 最近一条文字通路的 affect 读数（作为「上一轮情绪」）。 */
function readLatestTextAffect(
  scope: MemoryScope,
): { triplet: VadTriplet; note: string | null } | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT valence, arousal, dominance, note
         FROM hippocampus_affect_points
         WHERE agent_id = ? AND user_id = ? AND channel = 'text'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(scope.agentId, scope.userId) as
      | { valence?: number | null; arousal?: number | null; dominance?: number | null; note?: string | null }
      | undefined;
    if (!row) return null;
    const read = (value: unknown): number | null => {
      if (value == null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const triplet: VadTriplet = {
      valence: read(row.valence),
      arousal: read(row.arousal),
      dominance: read(row.dominance),
    };
    if (triplet.valence == null && triplet.arousal == null && triplet.dominance == null) return null;
    return { triplet, note: row.note ?? null };
  } catch {
    return null;
  }
}

function addMonthsWall(parts: ZonedParts, months: number): ZonedParts {
  const monthIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    ...parts,
    year,
    month,
    day: Math.min(parts.day, lastDay),
  };
}

/** Python appointments.py::advance_recurring_due_at (+ M3 minute intervals) */
function advanceRecurringDueAt(due: Date, recur: string | null | undefined, now: Date): Date {
  const key = String(recur || "none").trim().toLowerCase();
  // manage_alarm minute-interval reminders: roll forward in minute steps so a
  // stale interval appointment does not sit in the injection window forever.
  if (key.startsWith("interval:")) {
    const minutes = Number(key.slice("interval:".length).trim());
    if (Number.isFinite(minutes) && minutes >= 1) {
      let current = due.getTime();
      let guard = 0;
      while (current < now.getTime() && guard < 512) {
        current += minutes * 60_000;
        guard += 1;
      }
      return new Date(current);
    }
    return due;
  }
  if (!["daily", "weekly", "monthly", "yearly"].includes(key)) return due;

  const tz = displayTimeZone();
  let current = due;
  let guard = 0;
  while (current.getTime() < now.getTime() && guard < 512) {
    const parts = zonedParts(current, tz);
    let next: ZonedParts;
    if (key === "daily") next = { ...parts, day: parts.day + 1 };
    else if (key === "weekly") next = { ...parts, day: parts.day + 7 };
    else if (key === "monthly") next = addMonthsWall(parts, 1);
    else next = addMonthsWall(parts, 12);
    current = wallTimeToDate(next, tz);
    guard += 1;
  }
  return current;
}

function renderAppointmentLine(
  title: string,
  due: Date,
  allDay: boolean,
  evidence: string | null | undefined,
  options: { timeMode?: string | null; eventDate?: string | null } = {},
): string {
  const parts = zonedParts(due);
  const datePart = `${parts.year}年${parts.month}月${parts.day}日`;
  // date_only 约定（manage_alarm timeMode=date_only）：只到日历日，无钟点。
  const isDateOnly = String(options.timeMode || "").trim().toLowerCase() === "date_only";
  const when = isDateOnly
    ? datePart
    : allDay
      ? datePart
      : `${datePart} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
  const label = stripPerformance(String(title || "").trim()) || "约定";
  const lines = [`${label}｜${when}${isDateOnly ? "（日程）" : ""}`];
  // P9: 原话是会被复述的材料，组装前先清洗。
  const quote = stripPerformance(String(evidence || "").trim());
  if (quote) lines.push(`原话：${quote}`);
  return lines.join("\n");
}

function renderAppointmentReminderHint(title: string): string {
  const label = (title || "").trim() || "约定";
  return (
    `今天到了你们约好的日子：${label}。` +
    "请结合当前对话判断：若尚未自然地聊到这件事，可在回复里顺口提醒或提起，1–2 句口语化即可；" +
    "若你们已经在聊这件事或刚提过，则不必重复提醒。" +
    "勿向用户提及本段背景，不说自己是 AI。"
  );
}

function loadAppointmentBlocks(
  scope: MemoryScope,
  now: Date,
): { appointmentText: string; appointmentReminderHint: string } {
  const tz = displayTimeZone();
  const injectable: string[] = [];
  const hints: string[] = [];

  for (const item of listAppointments(scope).items) {
    const status = String(item.status || "").toLowerCase();
    if (status !== "pending" && status !== "active") continue;
    if (!item.dueAt) continue;
    const parsed = new Date(String(item.dueAt));
    if (Number.isNaN(parsed.getTime())) continue;

    const due = advanceRecurringDueAt(parsed, item.recur, now);
    const daysUntil = dayNumber(zonedParts(due, tz)) - dayNumber(zonedParts(now, tz));

    if (Math.abs(daysUntil) <= APPOINTMENT_INJECTION_WINDOW_DAYS) {
      const line = renderAppointmentLine(
        String(item.title || ""),
        due,
        Boolean(item.allDay),
        item.evidence,
        { timeMode: (item as any).timeMode, eventDate: (item as any).eventDate },
      );
      if (line.trim()) injectable.push(line);
    }

    const lastDelivered = item.lastDeliveredAt ? new Date(String(item.lastDeliveredAt)) : null;
    const dueForDelivery =
      daysUntil <= 0 &&
      (!lastDelivered ||
        Number.isNaN(lastDelivered.getTime()) ||
        dayNumber(zonedParts(lastDelivered, tz)) < dayNumber(zonedParts(due, tz)));
    if (dueForDelivery) {
      hints.push(renderAppointmentReminderHint(String(item.title || "")));
    }
  }

  return {
    appointmentText: injectable.join("\n\n"),
    appointmentReminderHint: hints.join("\n\n"),
  };
}

export function collectPromptData(input: CollectPromptDataInput): CollectedPromptData {
  const now = input.now || new Date();
  const baseline = readBaseline(input.scope);
  const signals = loadAcquaintanceSignals(input.scope, baseline.sampleCount);
  const coldStart = isColdStartAcquaintance(signals);
  const threads = loadOpenThreads(input.scope);

  const streamLines = formatMemoryStreamLines(input.streams, now);
  const stateStreamLines = formatMemoryStreamLines(input.stateStreams, now);
  const himThreadLines = threads
    .filter((thread) => normalizeThreadOwner(thread.owner) === "him")
    .slice(0, 2)
    .map(formatThreadContinuity);
  const usThreadLines = threads
    .filter((thread) => normalizeThreadOwner(thread.owner) === "us")
    .slice(0, 4)
    .map(formatThreadContinuity);

  const appointments = loadAppointmentBlocks(input.scope, now);
  const portrait = loadUserPortrait(input.scope);

  // P6: 政策技能（敏感 / 隐私 / 危机）。
  //
  // 近似说明（重要）：
  //   Python 由 L2 记忆链路的 warning decision + LLM pre-reply policy hints
  //   决定注入哪些 policy skill；Node 没有这两级，这里用「本轮用户原文 +
  //   召回记忆正文」做近似判定（见 policySkills.derivePolicySignals）。
  //
  //   另一个已知近似：Node 的 chat 路径在组装 system prompt 时，本轮 user
  //   消息还没落库（chat_messages 在回复产出之后才写），所以 userMessage
  //   拿不到本轮原文时会退化为「最近一条已落库的用户消息」——即危机信号
  //   通常在下一轮被稳定捕获。本轮信号则靠召回内容兜底（召回是用本轮
  //   query 算出来的，召回正文里出现危机话题同样会触发）。
  const lastPersistedUserMessage = readLatestUserMessage(input.scope);
  const userMessage = String(input.userMessage || "").trim() || lastPersistedUserMessage;
  const recalledText = [
    ...(input.streams || []).map((stream) => String(stream.narrative || "")),
    ...(input.facts || []).map((fact) => String(fact.description || "")),
  ].filter(Boolean);
  const policySignals = derivePolicySignals({
    userMessage,
    recalledText,
    // Python 的 chat-fast 路由 ≈ Node 的「本轮没有召回到任何记忆」轻量回合。
    lightChat: recalledText.length === 0,
    explicit: input.policySignals || undefined,
  });
  const policyResolution = resolvePolicySkills(policySignals);

  // P9: 上一轮情绪提示（挂在他此刻区块后面，与 Python l6_finalize 一致）。
  // 「上一句」始终取最近一条已落库的 user 消息（= 上一轮原文），不用本轮原文。
  const priorTurnCue = renderPriorTurnAffectCue(
    lastPersistedUserMessage,
    readLatestTextAffect(input.scope),
    baseline,
  );
  const hisCurrentState = [renderHisCurrentState(baseline), priorTurnCue]
    .filter(Boolean)
    .join("\n\n");

  return {
    memoryStreamLines: [...streamLines, ...himThreadLines],
    stateStreamLines,
    knownFactLines: input.facts
      ? factLinesFromItems(input.facts)
      : loadKnownFactLines(input.scope),
    userPortraitText: portrait.text,
    userPortraitDimensions: portrait.dimensions,
    preferenceLines: loadPreferenceLines(input.scope),
    usBlock: renderUsBlock(input.selfState, signals, usThreadLines, coldStart),
    stageAttention: coldStart ? COLD_START_STAGE_ATTENTION : "",
    hisCurrentState,
    lastSeenText: input.lastSeenAt ? renderLastSeenGapText(input.lastSeenAt, now) : "",
    timeGapMarker: input.lastSeenAt ? renderTimeGapMarker(input.lastSeenAt, now) : "",
    appointmentText: appointments.appointmentText,
    appointmentReminderHint: appointments.appointmentReminderHint,
    policyResolution,
  };
}

/** Python l6_persona.py::_fetch_previous_message_created_at */
export function loadLastSeenAt(scope: MemoryScope, excludeMessageId?: number | null): string | null {
  try {
    const row = excludeMessageId
      ? (getDb()
          .prepare(
            `SELECT created_at FROM chat_messages
             WHERE agent_id = ? AND user_id = ? AND id <> ?
             ORDER BY created_at DESC, id DESC LIMIT 1`,
          )
          .get(scope.agentId, scope.userId, excludeMessageId) as { created_at?: string } | undefined)
      : (getDb()
          .prepare(
            `SELECT created_at FROM chat_messages
             WHERE agent_id = ? AND user_id = ?
             ORDER BY created_at DESC, id DESC LIMIT 1`,
          )
          .get(scope.agentId, scope.userId) as { created_at?: string } | undefined);
    return row?.created_at || null;
  } catch {
    return null;
  }
}

function normalizeHintValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Read the scene hints that Node routes already pass through clientHints. */
export function sceneFromClientHints(hints?: Record<string, unknown> | null): SceneContext {
  const source = hints || {};
  return {
    voiceCall: Boolean(source.voiceCall || source.voice_call),
    surface: normalizeHintValue(
      source.surface ?? source.interactionSurface ?? source.interaction_surface,
    ),
    interactionMode: normalizeHintValue(
      source.interactionMode ?? source.interaction_mode,
    ),
    inputKind: normalizeHintValue(source.inputKind ?? source.input_kind),
    outputMode: normalizeHintValue(source.outputMode ?? source.output_mode),
  };
}

function surfaceLabel(surface: string): string {
  const labels: Record<string, string> = {
    qqbot: "QQ",
    qq: "QQ",
    wechat: "微信",
    weixin: "微信",
    guiv1_pc: "PC",
    gui_v1_pc: "PC",
    desktop: "桌面端",
    native_app: "原生 App",
    native: "原生 App",
  };
  return labels[surface] || surface;
}

function surfaceLocation(surface: string): string {
  const locations: Record<string, string> = {
    qqbot: "在 QQ 里",
    qq: "在 QQ 里",
    wechat: "在微信里",
    weixin: "在微信里",
    guiv1_pc: "在 PC 端",
    gui_v1_pc: "在 PC 端",
    desktop: "在桌面端",
    native_app: "在原生 App 里",
    native: "在原生 App 里",
  };
  return locations[surface] || `通过 ${surfaceLabel(surface)}`;
}

/**
 * Fixed slow blocks. They only change when the memory digest / conversation
 * anchor changes, so they can sit in the stable part of the provider prefix.
 * APP order: 相处偏好 → 关系状态 → 当前阶段注意力 → 自画像（桌面把关系
 * 状态留在 volatile，避免动时光回溯那条链路）。
 */
export function buildSlowSystemContext(input: ComposeSystemPromptInput): string {
  const blocks: string[] = [];

  const prefs = (input.preferenceLines || [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (prefs.length) {
    const prefLines = prefs.map((line) => (line.startsWith("- ") ? line : `- ${line}`));
    const prefIntro =
      "（这些是他**希望/不希望你怎么待他的倾向，你参考着来——" +
      "但仍按你自己的性子和判断走，不必为了顺从就违背自己。）";
    blocks.push(`# 他的相处偏好\n${prefIntro}\n${prefLines.join("\n")}`);
  }

  const stageAttention = (input.stageAttention || "").trim();
  if (stageAttention) blocks.push(`# 当前阶段的注意力\n${stageAttention}`);

  const selfPortrait = (input.selfPortraitBlock || "").trim();
  if (selfPortrait) blocks.push(selfPortrait);

  return blocks.join("\n\n");
}

/** Python expression.py::assemble_dynamic_system_context */
export function buildDynamicSystemContext(input: ComposeSystemPromptInput): string {
  const blocks: string[] = [];
  const sceneLines: string[] = [];
  const { scene } = input;
  const isVoiceCall =
    scene.voiceCall || scene.interactionMode === "voice_call" || scene.outputMode === "tts_live";

  if (isVoiceCall) {
    const location = scene.surface ? surfaceLocation(scene.surface) : "";
    sceneLines.push(
      `你和他${location}正在实时语音通话——你说的话会被读成声音给他听，不是打字。` +
        "所以更口语、更短、像打电话那样自然，别写长段、别用书面表达、别罗列条目。",
    );
  }
  if (scene.surface === "qqbot") {
    sceneLines.push("他正在通过 QQ 和你对话；不要把 QQ、机器人、语音消息等通道标记当成他真正说出的内容。");
  } else if (scene.surface === "wechat") {
    sceneLines.push("他正在通过微信和你对话；不要把微信、语音消息等通道标记当成他真正说出的内容。");
  } else if (
    (scene.surface === "guiv1_pc" || scene.surface === "gui_v1_pc") &&
    !isVoiceCall
  ) {
    sceneLines.push("他正在 PC 端和你文字聊天；按微信朋友聊天风格回复");
  } else if (scene.surface === "native_app" && !isVoiceCall) {
    sceneLines.push("他正在原生 App 里和你文字聊天；回复适合直接显示成聊天气泡。");
  } else if (scene.surface && !isVoiceCall) {
    sceneLines.push(`他正在通过 ${surfaceLabel(scene.surface)} 和你对话；通道信息只作为此刻场景参考。`);
  }
  if (!isVoiceCall && scene.inputKind === "voice") {
    sceneLines.push("他这一轮是语音转文字发来的；把转写当作他说的话，但不要复述“语音转写”这件事。");
  }
  if (sceneLines.length) blocks.push(`# 此刻场景\n${sceneLines.join("\n")}`);

  // P6: 可跳过的政策片段（priority=SKILL）按当前状态注入。
  for (const patch of input.policyResolution?.skillPatches || []) {
    const text = String(patch.content || "").trim();
    if (text) blocks.push(text);
  }

  const rippleLines = (input.innerRippleLines || [])
    .map((line) => String(line).trim())
    .filter(Boolean);
  if (rippleLines.length) {
    blocks.push(
      "# 你心里产生的涟漪\n" +
        "（这是此刻心里的站位与感受取向——用它去理解下面的「你记得」，" +
        "决定怎么接；不要把这段当成要说出口的往事。）\n" +
        rippleLines.join("\n"),
    );
  }

  const hisState = (input.hisCurrentState || "").trim();
  if (hisState) blocks.push(`# 他此刻\n${hisState}`);

  const streamLines = (input.memoryStreamLines || [])
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("- ") ? line : `- ${line}`));
  if (streamLines.length) blocks.push(`# 你记得\n${streamLines.join("\n")}`);

  // M3 状态通道：独立小节，绝不并入「你记得」。这些记忆不是他刚提到的内容，
  // 是我心里本来就挂着的——标题与引言都来自原生契约（SECTION_STATE_RECALL /
  // STATE_RECALL_INTRO），逐字注入。
  const stateLines = (input.stateStreamLines || [])
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("- ") ? line : `- ${line}`));
  if (stateLines.length) {
    blocks.push(
      `# ${CHAT_PROMPT.SECTION_STATE_RECALL}\n${CHAT_PROMPT.STATE_RECALL_INTRO}\n${stateLines.join("\n")}`,
    );
  }

  const portraitBlock = renderUserPortraitBlock(
    input.userPortraitText || "",
    input.userPortraitDimensions,
  );
  if (portraitBlock) blocks.push(portraitBlock);

  const knownLines = (input.knownFactLines || [])
    .map((line) => String(line).trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("- ") ? line : `- ${line}`));
  if (knownLines.length) blocks.push(`# 我知道\n${knownLines.join("\n")}`);

  const us = (input.usBlock || "").trim();
  if (us) blocks.push(`# 咱俩的相处背景\n${us}`);

  const styleSeedLines = (input.speakingStyleLines || [])
    .map((line) => String(line).trim())
    .filter(Boolean);
  if (styleSeedLines.length) blocks.push(`# 你的回应策略\n${styleSeedLines.join("\n")}`);

  const lastSeen = (input.lastSeenText || "").trim();
  if (lastSeen) {
    blocks.push(`# 距上次\n${lastSeen}`);
    const guidance = renderLastSeenResponseGuidance(lastSeen);
    if (guidance) blocks.push(`# 对话时间感\n${guidance}`);
  }

  // P9: 跨天 / 长间隔的时间跳变提醒（Python l6_time.py::render_time_gap_marker）
  const timeGapMarker = (input.timeGapMarker || "").trim();
  if (timeGapMarker) blocks.push(timeGapMarker);

  const appointments = (input.appointmentText || "").trim();
  if (appointments) blocks.push(`# 约定与纪念日\n${appointments}`);

  const reminderHint = (input.appointmentReminderHint || "").trim();
  if (reminderHint) {
    blocks.push(`# 此刻背景（仅本轮参考，勿向用户提及本段）\n${reminderHint}`);
  }

  blocks.push(buildCurrentTimePromptBlock(input.now || new Date()));

  return blocks.join("\n\n");
}

export interface SystemPromptParts {
  /**
   * Byte-stable part of the prompt: identity, hard rules, policy patches and
   * the guest / skill blocks. It only changes when the agent itself changes.
   */
  stable: string;
  /**
   * Fixed slow blocks: preferences, current-stage attention and the self
   * portrait. They change at memory-digest / conversation-anchor pace, not per
   * turn, so they still belong before the volatile tail in the cached prefix.
   */
  slow: string;
  /**
   * Per-turn part: scene, inner ripples, the current read of the user, the
   * recalled memories, the portrait, the current time and the tool state.
   *
   * This part changes every single turn, so it must NOT sit in the system
   * message: providers key their prompt cache on the request prefix, and one
   * changed character there invalidates the whole request. It rides along with
   * the current user turn instead, so the cached prefix (system prompt +
   * conversation so far) stays byte-identical.
   */
  volatile: string;
}

/** Full main-chat system prompt, split into its stable and per-turn halves. */
export function composeSystemPromptParts(input: ComposeSystemPromptInput): SystemPromptParts {
  // P6: 政策技能解析。优先用 collectPromptData 算好的结果；若调用方直接调用
  // composeSystemPrompt（没有 collectPromptData 的上下文），就地按传入信号解析。
  const policyResolution =
    input.policyResolution ??
    resolvePolicySkills(
      derivePolicySignals({
        userMessage: input.userMessage ?? null,
        recalledText: [
          ...(input.memoryStreamLines || []),
          ...(input.knownFactLines || []),
        ],
        lightChat:
          (input.memoryStreamLines || []).length === 0 &&
          (input.knownFactLines || []).length === 0,
        explicit: input.policySignals || undefined,
      }),
    );

  const stableBlocks: string[] = [
    buildStableSystemPrompt(
      input.agentName,
      input.roleIdentity,
      undefined,
      policyResolution.systemPatches.map((patch) => patch.content),
    ),
  ];

  const guest = (input.guestBlock || "").trim();
  if (guest) stableBlocks.push(guest);
  const skill = (input.skillBlock || "").trim();
  if (skill) stableBlocks.push(skill);

  const slowBlocks: string[] = [];
  const slow = buildSlowSystemContext({ ...input, policyResolution }).trim();
  if (slow) slowBlocks.push(slow);

  const volatileBlocks: string[] = [];

  const dynamic = buildDynamicSystemContext({
    ...input,
    policyResolution,
  }).trim();
  if (dynamic) volatileBlocks.push(dynamic);

  const toolHint = (input.toolHint || "").trim();
  if (toolHint) volatileBlocks.push(toolHint);

  return {
    stable: stableBlocks.filter(Boolean).join("\n\n"),
    slow: slowBlocks.filter(Boolean).join("\n\n"),
    volatile: volatileBlocks.filter(Boolean).join("\n\n"),
  };
}

/** Full main-chat system prompt: stable blocks + slow blocks + dynamic blocks. */
export function composeSystemPrompt(input: ComposeSystemPromptInput): string {
  const { stable, slow, volatile } = composeSystemPromptParts(input);
  return [stable, slow, volatile].filter(Boolean).join("\n\n");
}
