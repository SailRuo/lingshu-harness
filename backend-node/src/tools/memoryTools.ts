import type { ToolContext, ToolResult } from "./nativeTools.js";
import { manageAlarm } from "../services/appointmentService.js";
import { saveMemory } from "../services/memoryService.js";
import { searchMemory } from "../services/memorySearchService.js";

/**
 * M3 memory tools — desktop backends for the APP's three always-on memory
 * tools. Schema / copy follow the APP definitions (`src/tools/alarm.ts`,
 * `src/tools/memorySearch.ts`, `src/tools/memory.ts`) but execution is local:
 * save_memory → memoryService.saveMemory, search_memory → memorySearchService,
 * manage_alarm → appointmentService (hippocampus_appointments + the existing
 * reminder scheduler).
 *
 * All three are `alwaysEnabled` (base abilities, no toggle) and every failure
 * returns status=error: the prompt contract says a tool Error means "not done"
 * and the model must never claim it remembered / found / set something.
 */

export const SAVE_MEMORY_TOOL_NAME = "save_memory";
export const SEARCH_MEMORY_TOOL_NAME = "search_memory";
export const MANAGE_ALARM_TOOL_NAME = "manage_alarm";

const SAVE_MEMORY_DESCRIPTION =
  "主动记忆：对话中用户明确确认、要求记住或长期成立的稳定事实、特征与偏好，当场写入长期记忆。" +
  "调用策略：用户自我介绍、明确要求记住某事、表达喜欢/讨厌/兴趣、说明住址职业作息习惯或个人特征时调用；" +
  "纯闲聊话题、玩笑、临时测试都不写。" +
  "evidence 必须是用户原话且能在最近对话中逐字找到；" +
  "同主体同关系重复写入会自动合并，不会重复记录。" +
  "工具返回 Error 表示未写入，不能对用户声称已记住。";

const SEARCH_MEMORY_DESCRIPTION =
  "回忆工具\n" +
  "这些情况要调用：\n" +
  "①对方问起某件事，而你一时想不起相关细节；\n" +
  "②对方问「你还记得…吗」「之前说过/聊过…吗」这类想让你回忆的事，而当前对话上下文里没有能接住的内容。\n" +
  "想不起具体时间也可以直接想：time=最近 即可；更久往宽处想（如 time=90天前、time_end=今天）。\n" +
  "调用前可以先告诉对方「让我想想」这种正在回忆的状态。工具返回的就是你想起来的旧事，已按发生时间排好；" +
  "像「我想起来了」「我记得那天…」这样自然地讲出来，就像旧事自己浮上心头。真想不起来的，就照实说想不起来。";

const ALARM_MUST_CREATE =
  "【强制】用户已说清未来要办的事，本轮必须先 create 再陪伴回复；禁止正文叮嘱却不 create。" +
  "相对时间必须对照本轮「当前时间」换算成绝对日期/时刻再传参，不要靠枚举说法去匹配。" +
  "①能定到具体钟点或 N 分钟后 → timeMode=exact + startAt；" +
  "②只能定到日历日（含「某天晚上/早上」但没有几点）→ timeMode=date_only + eventDate=换算后的 YYYY-MM-DD，不要自编钟点；" +
  "近期已说清但约定列表里还没有的，本轮须补 create。" +
  "不必等用户说「提醒我」。仅当事项或时间仍无法确定、还在商量、或明确拒绝时可不创建。";

const ALARM_SHARED_TAIL =
  "严格只接受 action、id、title、startAt、timeMode、eventDate、recurrence、intervalMinutes；不得传 time、repeat、label 或任何自造字段。" +
  "exact：startAt 必须为未来 ISO-8601，例如 2026-07-25T08:00:00+08:00；recurrence：none/daily/weekly/interval。" +
  "date_only：必填 eventDate=YYYY-MM-DD（东八区日历日），不要传钟点 startAt；系统自动定提醒时刻（优先前一晚20:00，已过则当天08:00）；date_only 固定 recurrence=none。" +
  "「每30分钟提醒喝水」→ timeMode=exact、recurrence=interval、intervalMinutes=30、startAt=此刻+30分钟。" +
  "取消：先 action=list，再用返回行里的方括号 ID 调用 action=delete 且必须带 id。" +
  "工具返回 Error 即表示未成功，不能对用户声称已设置/已取消。";

const MANAGE_ALARM_DESCRIPTION =
  "提醒管理（约定）：负责用户已确定的未来日程与到点事项。" +
  ALARM_MUST_CREATE +
  "写入本地约定；到期时若正在和该伙伴聊天则注入提醒。" +
  ALARM_SHARED_TAIL;

export interface MemoryToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MEMORY_TOOL_DEFINITIONS: MemoryToolDefinition[] = [
  {
    name: SAVE_MEMORY_TOOL_NAME,
    description: SAVE_MEMORY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        memory_type: {
          type: "string",
          enum: ["fact", "preference"],
          description: "fact 稳定事实；preference 主观偏好（配 LIKES/DISLIKES/INTERESTED_IN）。",
        },
        relation: {
          type: "string",
          description:
            "关系类型。优先使用基础预设：HAS_NAME（姓名/昵称）、AGE（年龄）、GENDER（性别）、LIVES_IN（居住地）、OCCUPATION（职业）、SLEEP_PATTERN（作息）、LIKES（喜好）、DISLIKES（反感/忌口）、HAS_PET（宠物）、HAS_FRIEND（朋友）、HAS_FAMILY（家人）、INTERESTED_IN（兴趣）、HAS_HEALTH_CONDITION（健康状况/病史）、HAS_ROUTINE（生活习惯）、HAS_WORK_PATTERN（工作规律）。若事实超出上述预设，可自主命名规范的大写英文关系（如 HAS_BODY_FEATURE、FAVORITE_COLOR 等），并务必填写清晰的中文 description。",
        },
        subject: {
          type: "string",
          description: "断言主体：Me=用户本人；Self=你自己。默认 Me。",
        },
        object: {
          type: "string",
          description: "断言对象（客体实体），如具体的人/地/物/特征/习惯。",
        },
        description: {
          type: "string",
          description:
            "一句话概括该事实的完整中文描述（如「他喜欢吃火锅」）。自定义 relation 时必填。",
        },
        evidence: {
          type: "string",
          description: "用户原话直接片段，必须能在最近对话的用户发言中逐字找到。必填。",
        },
        confidence: { type: "number", description: "0~1，默认 0.7。" },
      },
      required: ["memory_type", "relation", "object", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: SEARCH_MEMORY_TOOL_NAME,
    description: SEARCH_MEMORY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要回想的内容或话题关键词，如「约好去吃的火锅店」「考试」「吵架」。必填。",
        },
        time: {
          type: "string",
          description:
            "时间点或时间段起点。支持：具体日期（2026-09-15 / 9月15日）或 今天 / 昨天 / 前天 / 大前天 / N天前 / 上周 / 上周一~上周日 / 上个月。省略 time_end 时按自然范围：具体日期取当天全天，上周取上周整周，上个月取上个自然月。必填。",
        },
        time_end: {
          type: "string",
          description: "时间段终点（可选，词表同 time）。例如 time=上周一、time_end=上周三 表示上周一至周三。",
        },
      },
      required: ["query", "time"],
      additionalProperties: false,
    },
  },
  {
    name: MANAGE_ALARM_TOOL_NAME,
    description: MANAGE_ALARM_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "delete"],
          description: "操作：create 创建、list 查询、delete 取消。",
        },
        id: { type: "string", description: "仅 delete 使用；必须是此前 list 返回的提醒 ID。" },
        title: { type: "string", description: "仅 create 使用；提醒显示名称。" },
        timeMode: {
          type: "string",
          enum: ["exact", "date_only"],
          description: "仅 create：exact=有具体钟点（默认）；date_only=只有日历日没有钟点。",
        },
        eventDate: {
          type: "string",
          description:
            "仅 timeMode=date_only 必填；东八区日历日 YYYY-MM-DD，例如 2026-10-08。不要传钟点。",
        },
        startAt: {
          type: "string",
          description:
            "仅 timeMode=exact（或未传 timeMode）时必填；未来的 ISO-8601 时间，例如 2026-07-25T08:00:00+08:00。date_only 不要传。",
        },
        recurrence: {
          type: "string",
          enum: ["none", "daily", "weekly", "interval"],
          description:
            "仅 exact create；none 一次、daily 每天、weekly 每周、interval 按分钟循环。date_only 固定 none。",
        },
        intervalMinutes: {
          type: "number",
          description: "仅当 recurrence=interval 时必填；间隔分钟数，整数，范围 1～1440。例如每30分钟=30。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

function failure(message: string): ToolResult {
  return {
    status: "error",
    preview: `Error: ${message}`,
    error_class: "memory_tool_error",
    summary: { strategy: "inline", source: "native" },
  };
}

function success(preview: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    status: "success",
    preview,
    summary: { strategy: "inline", source: "native" },
    ...extra,
  };
}

function scopeOf(context: ToolContext): { agentId: number; userId: string | null } {
  const agentId = Number(context.agentId);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    throw new Error("需要绑定智能体才能使用记忆工具");
  }
  const userId = context.userId ? String(context.userId) : null;
  return { agentId, userId };
}

/** Entry point wired into nativeTools.executeNativeTool. */
export async function executeMemoryTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const { agentId, userId } = scopeOf(context);
    if (name === SAVE_MEMORY_TOOL_NAME) {
      const result = await saveMemory({
        agentId,
        userId,
        threadId: context.sessionId ?? null,
        memoryType: String(args.memory_type || "fact") === "preference" ? "preference" : "fact",
        relation: String(args.relation || ""),
        subject: String(args.subject || "Me"),
        object: String(args.object ?? args.to ?? ""),
        description: String(args.description || ""),
        evidence: String(args.evidence || ""),
        confidence: Number(args.confidence),
      });
      if (!result.ok) return failure(result.message);
      return success(result.message, {
        ...(result.factId ? { fact_id: result.factId } : {}),
        ...(result.constraintId ? { constraint_id: result.constraintId } : {}),
        merged: Boolean(result.merged),
      });
    }
    if (name === SEARCH_MEMORY_TOOL_NAME) {
      const result = await searchMemory({
        agentId,
        userId,
        query: String(args.query || ""),
        time: String(args.time || ""),
        timeEnd: String(args.time_end || ""),
      });
      return success(result);
    }
    if (name === MANAGE_ALARM_TOOL_NAME) {
      const result = manageAlarm({
        agentId,
        userId,
        action: String(args.action || "") as "create" | "list" | "delete",
        id: String(args.id || args.alarm_id || ""),
        title: String(args.title || ""),
        timeMode:
          String(args.timeMode || args.time_mode || "exact").toLowerCase() === "date_only"
            ? "date_only"
            : "exact",
        eventDate: String(args.eventDate || args.event_date || ""),
        startAt: String(args.startAt || args.start_at || ""),
        recurrence: (["none", "daily", "weekly", "interval"] as const).includes(
          String(args.recurrence || "none").toLowerCase() as any,
        )
          ? (String(args.recurrence || "none").toLowerCase() as "none" | "daily" | "weekly" | "interval")
          : "none",
        intervalMinutes: Number(args.intervalMinutes ?? args.interval_minutes),
      });
      if (!result.ok) return failure(result.message);
      return success(result.message, {
        ...(result.appointmentId ? { appointment_id: result.appointmentId } : {}),
      });
    }
    return failure(`未知记忆工具: ${name}`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
