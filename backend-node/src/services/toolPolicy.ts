import { getDb } from "../db/sqlite.js";
import { getSettings } from "./settingsService.js";
import { dayKey, displayTimeZone, zonedParts } from "./memoryTime.js";
import { PROMPT as CHAT_PROMPT } from "../contracts/native/nativeChatContract.js";

/**
 * Port of Python `core/companion/tool_policy.py`.
 *
 * The Node backend had no tool-use policy at all: the system prompt carried a
 * one-line `TOOL_HINT` and nothing told the model when a tool may be used, how
 * to answer after a tool ran, or what "sending a photo" is allowed to look
 * like. These constants are the direct translation of the Python policy text
 * (kept byte-identical on purpose so both runtimes instruct the model the
 * same way).
 */

export const IMAGE_REPLY_IMMERSION = "对用户勿提：生成、生图、AI、工具、冷却、配额、次数、系统。";

// Hard rule: models often claim "给你了/这张" without a successful tool result.
export const IMAGE_NO_FAKE_SEND =
  "未成功禁止装已发（勿说给你了/看这张/拍好了等），只能推脱或改口。" +
  "只有本轮工具结果明确写着照片已送达用户屏幕，或历史里有 [我发出的照片N] 标记，才算真发过；" +
  "两者都没有=没发过。";

/**
 * Appended to the tool result of a successful `generate_image`.
 *
 * The tool result is the only place where the model learns that the picture
 * reached the user — without it the model has no way to tell "I sent it" from
 * "it failed" and apologises for a photo the user is looking at right now.
 */
export const IMAGE_DELIVERY_NOTE =
  "照片已经作为图片消息推送到用户的聊天窗口，用户此刻已经在屏幕上看到了它。" +
  "请在角色口吻里自然地回应这件事（例如「给你了」「刚那张」「你看那张」），" +
  "可以顺带提一句画面里的内容；不要说「生成」「生图」「工具」「系统」，不要贴 URL 或 markdown 图片语法，" +
  "也不要再道歉说没发出来。";

export const COMPANION_TOOL_USE_POLICY =
  "\n\n【工具使用边界】默认不要调用工具。只有同时满足以下条件时，才通过 tool_calls 调用已绑定工具：" +
  "用户明确要求你执行外部操作或获取当前实时状态；该目标无法仅凭对话上下文可靠完成；" +
  "且某个已绑定工具的能力与目标直接匹配。" +
  "用户只是闲聊、表达感受、寻求建议、解释概念、复盘刚才对话，或只是提到某类事项但未明确要求执行/实时查询时，不要调用工具。" +
  "\n【调用纪律】在发起 tool_calls 时直接调用工具，严禁在 tool_calls 前输出半截未完的句子（如「稍等我」「这就给你查」等截断短语）；若无必要调用前无需发言，待工具返回结果后直接给出完整自然、口语化的回复。" +
  "\n【结果回复】工具执行完成后给出最终回复时，直接根据工具返回的数据自然表达，严禁重复此前已说过的过渡句或复述套路开场白（例如若此前已表达过查询意图，后续回复直接给出结果，切勿重复「好的我帮你查到了」等冗余开场）。";

export const END_VOICE_CALL_BOUND_POLICY =
  "\n\n【通话挂断】end_voice_call 已绑定。是否挂断由你根据当前对话自行判断。" +
  "当用户明确要求你挂断、结束通话、离开或不要再听时，必须调用 end_voice_call，" +
  "不能只用文字说『我先挂了』而保持通话继续。调用时必须在 farewell 参数写一句简短自然的挂断语；" +
  "系统会直接播报它并在播完后挂断，不会再请求你补一句。";

export const IMAGE_GEN_BOUND_POLICY =
  "\n\n【发图】用户本轮明确要看图/自拍/照片/画画才可调 generate_image，勿主动发。" +
  "本人自拍/形象照须 use_agent_avatar=true，此时 prompt 必须倾向第一人称自拍视角（如手持前置镜头自拍/对镜自拍/半身自拍），严禁使用「一个女孩/一位年轻女性/她」等第三人称，只写动作、服装、姿势、场景与光线，严禁改写或形容五官长相；" +
  "若画无关风景/物品/概念插画等无需参考图（use_agent_avatar=false），则人称与视角随意。" +
  "成功后系统单独推图，你只自然语言接话，勿贴 URL/markdown/<file>。" +
  "【收到成功结果时】工具结果里会写明照片已送达用户屏幕，并附画面描述；这时你必须承认照片已经发出，" +
  "用角色口吻自然地说出来（例如「给你了」「刚拍的那张」「你看那张」），可以提一句画面内容，" +
  "严禁说「没发出来」「我这边看不到」「抱歉没能给你」这类否认；也不要说「生成」「生图」「工具」「系统」。" +
  "【只有失败时】才可以说没发出来，并顺势把话圆回来。" +
  "按关系亲疏决定给不给、给什么样子；勿连发（间隔未满则无此工具）。" +
  `${IMAGE_NO_FAKE_SEND}` +
  `${IMAGE_REPLY_IMMERSION}`;

export const IMAGE_GEN_COOLDOWN_UNBOUND_POLICY =
  "\n\n【发图暂不可用】刚发过不久，间隔未满，现在发不出新图。他这轮要图就用角色口吻推脱或改口，" +
  "不要调用工具（调用只会拿到冷却失败，白白多一轮）。" +
  `${IMAGE_NO_FAKE_SEND}` +
  `${IMAGE_REPLY_IMMERSION}`;

export const IMAGE_GEN_QUOTA_EXHAUSTED_POLICY =
  "\n\n【发图不可用】今日不能再发，他这轮要图就用角色口吻推到改天，别调用工具。" +
  `${IMAGE_NO_FAKE_SEND}` +
  "勿提次数、配额、生成、工具、系统。";

export const IMAGE_GEN_DISABLED_POLICY =
  "\n\n【发图不可用】这台设备现在没有开启发图能力，他这轮要图就用角色口吻推到改天，别调用工具。" +
  `${IMAGE_NO_FAKE_SEND}` +
  "勿提次数、配额、生成、工具、系统。";

export interface CompanionToolPolicyState {
  /** generate_image is present in the tool list bound to this turn. */
  imageGenBound: boolean;
  /** The image service is configured but the tool is not available this turn. */
  imageGenUnavailable: boolean;
  /** model + baseUrl + apiKey + daily limit are all configured. */
  imageGenConfigured: boolean;
  /** end_voice_call is present in the tool list bound to this turn. */
  endVoiceCallBound: boolean;
  /** manage_alarm is present in the tool list bound to this turn (private chat). */
  manageAlarmBound?: boolean;
  /** Human readable "last photo sent at" stamp (internal, never shown to the user). */
  lastImageAtLabel?: string | null;
  /** Seconds left before the next photo may be generated. */
  imageCooldownRemainingS?: number;
  /** Photos still allowed today (null = unknown / unlimited). */
  imageDailyRemaining?: number | null;
}

/**
 * Python `companion_tool_policy_suffix`: build the extra policy text for the
 * companion system prompt.
 *
 * The image tool stays bound while it is cooling down — unbinding it would
 * change the request's tools array from one turn to the next, and the
 * provider keys its prompt cache on the request prefix. The tool answers with
 * the cooldown itself when it is called, so the policy only has to tell the
 * model what the current state is.
 */
export function companionToolPolicySuffix(state: CompanionToolPolicyState): string {
  const parts: string[] = [COMPANION_TOOL_USE_POLICY];
  if (state.endVoiceCallBound) parts.push(END_VOICE_CALL_BOUND_POLICY);
  // manage_alarm's always-on tool contract: companion personas often verbal-ack
  // timed plans ("好的到时候我提醒你") without writing the appointment — this
  // block forbids that. Verbatim from the native chat contract.
  if (state.manageAlarmBound) {
    parts.push(`\n\n${CHAT_PROMPT.MANAGE_ALARM_IMPLICIT_TOOL_INSTRUCTIONS.join("\n")}`);
  }
  const remainingCd = Math.max(0, Math.floor(Number(state.imageCooldownRemainingS || 0)));
  const lastLabel = String(state.lastImageAtLabel || "").trim() || "暂无";

  if (state.imageGenBound) {
    const dailyRemaining = state.imageDailyRemaining ?? null;
    if (remainingCd > 0) {
      parts.push(
        `${IMAGE_GEN_COOLDOWN_UNBOUND_POLICY}` +
          `内部：上次 ${lastLabel}，约还需 ${remainingCd} 秒（对用户禁止提）。`,
      );
    } else if (dailyRemaining !== null && dailyRemaining <= 0) {
      parts.push(IMAGE_GEN_QUOTA_EXHAUSTED_POLICY);
    } else {
      const remaining = dailyRemaining === null ? "" : `今日剩余 ${dailyRemaining} 次`;
      parts.push(
        `${IMAGE_GEN_BOUND_POLICY}内部：上次 ${lastLabel}，间隔已满；仍按关系判断。${remaining}`,
      );
    }
  } else if (state.imageGenUnavailable) {
    parts.push(IMAGE_GEN_DISABLED_POLICY);
  }
  return parts.join("");
}

// ─── Image generation configuration / quota ────────────────────────────────

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
export const END_VOICE_CALL_TOOL_NAME = "end_voice_call";

/** Python `image_gen_quota.IMAGE_GEN_COOLDOWN_SECONDS` default. */
export const DEFAULT_IMAGE_GEN_COOLDOWN_SECONDS = 180;

/**
 * Python `image_gen_quota.IMAGE_GEN_USAGE_ROW_ID`. The Node backend has no
 * dedicated image-usage table, so the counter lives in `settings_rows` (the
 * same generic key/value store the proactive pool already uses). Schema:
 * `{ date: "YYYY-MM-DD", count: number, last_sent_at: ISO | null }`.
 */
const IMAGE_GEN_USAGE_ROW_ID = "IMAGE_GEN_USAGE";

export interface ImageGenConfig {
  source: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dailyLimit: number;
  cooldownEnabled: boolean;
  cooldownSeconds: number;
  configured: boolean;
}

export interface ImageGenAvailability extends ImageGenConfig {
  nativeEnabled: boolean;
  cooldownRemainingS: number;
  dailyRemaining: number | null;
  lastImageAtLabel: string;
  /** True when the tool may be bound to a turn right now. */
  allowed: boolean;
  /** Why the tool is unavailable (null when allowed). */
  blockedReason: "not_configured" | "cooldown" | "quota" | null;
}

function readImageGenUsage(): { date: string; count: number; lastSentAt: string | null } {
  const row = getDb()
    .prepare("SELECT value FROM settings_rows WHERE id = ?")
    .get(IMAGE_GEN_USAGE_ROW_ID) as { value: string } | undefined;
  if (!row) return { date: "", count: 0, lastSentAt: null };
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object") return { date: "", count: 0, lastSentAt: null };
    const count = Number((parsed as any).count);
    return {
      date: String((parsed as any).date || ""),
      count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
      lastSentAt: (parsed as any).last_sent_at ? String((parsed as any).last_sent_at) : null,
    };
  } catch {
    return { date: "", count: 0, lastSentAt: null };
  }
}

function writeImageGenUsage(value: { date: string; count: number; lastSentAt: string | null }) {
  getDb()
    .prepare(
      "INSERT INTO settings_rows (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
    )
    .run(
      IMAGE_GEN_USAGE_ROW_ID,
      JSON.stringify({ date: value.date, count: value.count, last_sent_at: value.lastSentAt }),
    );
}

/**
 * Resolve the effective image-generation configuration from the settings.
 * Mirrors the resolution `nativeTools.generateImage` performs (provider record
 * first, flat legacy settings as fallback).
 */
export function resolveImageGenConfig(): ImageGenConfig {
  const settings = getSettings() as Record<string, any>;
  const provider = Array.isArray(settings.modelProviders)
    ? settings.modelProviders.find((item: any) => item.id === settings.imageGenProviderId)
    : null;
  const baseUrl = String((provider?.baseUrl || settings.imageGenBaseUrl || "")).replace(/\/+$/, "");
  const apiKey = String(provider?.apiKey || settings.imageGenApiKey || "");
  const model = String(
    settings.imageGenModel ||
      (Array.isArray(provider?.enabledModels) ? provider.enabledModels[0] : "") ||
      "",
  );
  const dailyLimit = Math.max(0, Number(settings.imageGenDailyLimit || 0) || 0);
  const cooldownSeconds = Math.max(
    0,
    Number(settings.imageGenCooldownSeconds ?? DEFAULT_IMAGE_GEN_COOLDOWN_SECONDS) ||
      DEFAULT_IMAGE_GEN_COOLDOWN_SECONDS,
  );
  return {
    source: String(settings.imageGenSource || "").trim().toLowerCase(),
    protocol: String(provider?.protocol || provider?.source || "").trim().toLowerCase(),
    baseUrl,
    apiKey,
    model,
    dailyLimit,
    cooldownEnabled: settings.imageGenEnableCooldown !== false,
    cooldownSeconds,
    configured: Boolean(model && baseUrl && apiKey && dailyLimit > 0),
  };
}

function formatLastSentAt(value: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  const parts = zonedParts(date, displayTimeZone());
  const pad = (input: number) => String(input).padStart(2, "0");
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

/**
 * Current availability of the image tool: configuration, cooldown gap and the
 * daily quota. The daily counter lives in `settings_rows` under
 * `IMAGE_GEN_USAGE` and is bumped by `recordSuccessfulImageGeneration`.
 */
export function readImageGenAvailability(now: Date = new Date()): ImageGenAvailability {
  const config = resolveImageGenConfig();
  const settings = getSettings() as Record<string, any>;
  const nativeEnabled = Boolean(
    (settings.nativeToolEnabled || {})?.[GENERATE_IMAGE_TOOL_NAME],
  );
  const usage = readImageGenUsage();
  const today = dayKey(now, displayTimeZone());
  const usedToday = usage.date === today ? usage.count : 0;

  let cooldownRemainingS = 0;
  if (config.cooldownEnabled && config.cooldownSeconds > 0 && usage.lastSentAt) {
    const last = new Date(usage.lastSentAt).getTime();
    if (Number.isFinite(last)) {
      const elapsed = (now.getTime() - last) / 1000;
      cooldownRemainingS = Math.max(0, Math.ceil(config.cooldownSeconds - elapsed));
    }
  }

  const dailyRemaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - usedToday) : null;

  let blockedReason: ImageGenAvailability["blockedReason"] = null;
  if (!config.configured) blockedReason = "not_configured";
  else if (cooldownRemainingS > 0) blockedReason = "cooldown";
  else if (dailyRemaining !== null && dailyRemaining <= 0) blockedReason = "quota";

  return {
    ...config,
    nativeEnabled,
    cooldownRemainingS,
    dailyRemaining,
    lastImageAtLabel: formatLastSentAt(usage.lastSentAt),
    allowed: blockedReason === null,
    blockedReason,
  };
}

/**
 * Record a successful generation: consume one daily slot and restart the send
 * cooldown. Python `image_gen_quota.record_successful_generation`.
 */
export function recordSuccessfulImageGeneration(now: Date = new Date()): {
  dailyLimit: number;
  used: number;
  remaining: number;
} {
  const config = resolveImageGenConfig();
  const today = dayKey(now, displayTimeZone());
  const usage = readImageGenUsage();
  const used = (usage.date === today ? usage.count : 0) + 1;
  writeImageGenUsage({ date: today, count: used, lastSentAt: now.toISOString() });
  const remaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - used) : 0;
  return { dailyLimit: config.dailyLimit, used, remaining };
}

/**
 * Restart the cooldown clock without consuming quota.
 * Python `image_gen_quota.bump_last_sent_at`.
 */
export function bumpImageGenCooldown(now: Date = new Date()): number {
  const today = dayKey(now, displayTimeZone());
  const usage = readImageGenUsage();
  const used = usage.date === today ? usage.count : 0;
  writeImageGenUsage({ date: today, count: used, lastSentAt: now.toISOString() });
  const config = resolveImageGenConfig();
  return Math.max(0, Math.floor(Number(config.cooldownSeconds || 0)));
}
