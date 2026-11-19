import { getDb } from "../db/sqlite.js";
import { memoryScope, type MemoryScope } from "./memoryScope.js";
import { advanceRecurringDueAt } from "./memoryService.js";
import { displayTimeZone, zonedParts } from "./memoryTime.js";

/**
 * manage_alarm tool backend — 主动提醒（约定）on the existing
 * `hippocampus_appointments` table. Mirrors the APP's NativeToolRuntimePlugin
 * alarm semantics:
 *
 *  - exact: future ISO-8601 `startAt`; recurrence none/daily/weekly/interval.
 *  - date_only: `eventDate` (东八区日历日, YYYY-MM-DD); the reminder moment is
 *    the previous evening 20:00, or the event day 08:00 once that is past —
 *    never a made-up clock time; recurrence is forced to none.
 *  - interval: stored as `recur = "interval:<minutes>"` (the APP's storage
 *    format), delivered through the existing appointment scheduler.
 *  - hard dedup: same agent + title + recur (+ event_date for date_only)
 *    already pending → "已存在", no duplicate row.
 *  - every failure returns ok=false: the tool contract forbids claiming a
 *    reminder was set when the tool answered Error.
 *
 * No manage_goal: the goal module is out of scope on desktop.
 */

const ZONE = displayTimeZone();

export type ManageAlarmAction = "create" | "list" | "delete";

export interface ManageAlarmInput {
  agentId: number;
  userId?: string | null;
  action: ManageAlarmAction;
  id?: string;
  title?: string;
  timeMode?: "exact" | "date_only";
  eventDate?: string;
  startAt?: string;
  recurrence?: "none" | "daily" | "weekly" | "interval";
  intervalMinutes?: number;
  now?: Date;
}

export interface ManageAlarmResult {
  ok: boolean;
  message: string;
  appointmentId?: number;
}

function formatShanghaiIso(date: Date): string {
  // Persist Asia/Shanghai wall clock (+08:00), never bare Instant Z — the UI
  // shows 年月日时分秒 (APP parity).
  const parts = zonedParts(date, ZONE);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}+08:00`
  );
}

function formatDateOnlyLabel(eventDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate);
  if (!match) return eventDate;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

function recurListSuffix(recurRaw: string | null | undefined): string {
  const recur = String(recurRaw || "none").trim().toLowerCase();
  if (!recur || recur === "none") return "";
  if (recur === "daily") return "（每天）";
  if (recur === "weekly") return "（每周）";
  const intervalMatch = /^interval:(\d+)$/.exec(recur);
  if (intervalMatch) return `（每${Number(intervalMatch[1])}分钟）`;
  return `（${recur}）`;
}

/** normalizeEventDate: strict YYYY-MM-DD; tolerates a full ISO prefix. */
function normalizeEventDate(raw: string): string {
  let text = String(raw || "").trim();
  if (!text) return "";
  if (text.length >= 10 && text.charAt(4) === "-" && text.charAt(7) === "-") {
    text = text.slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const probe = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== text) return "";
  return text;
}

/**
 * Date-only fire policy (Asia/Shanghai): prefer previous evening 20:00; if
 * that is past, morning of the event day 08:00; if that is also past the
 * appointment cannot be created (choose a later date or exact+startAt).
 */
function resolveDateOnlyFireAt(eventDateYmd: string, now: Date): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDateYmd);
  if (!match) throw new Error("eventDate 必须是 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const wallAt = (y: number, m: number, d: number, hour: number, minute: number) =>
    new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - 8 * 3_600_000);
  const prevEve = wallAt(year, month, day - 1, 20, 0);
  if (prevEve.getTime() > now.getTime()) return prevEve;
  const morning = wallAt(year, month, day, 8, 0);
  if (morning.getTime() > now.getTime()) return morning;
  throw new Error(
    `日程日 ${eventDateYmd} 的提醒时刻已过（前晚20:00与当天08:00均已过去）。请换更晚的日期或改用 exact+startAt`,
  );
}

function parseStartAt(raw: string): number | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeAlarmRecur(
  recurrence: string | null | undefined,
  intervalMinutesRaw: unknown,
): { recur: string; error?: string } {
  const recur = String(recurrence || "none").trim().toLowerCase();
  if (!recur) return { recur: "none" };
  if (recur === "none" || recur === "daily" || recur === "weekly") return { recur };
  if (recur === "interval") {
    const minutes = Math.round(Number(intervalMinutesRaw));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      return { recur: "none", error: "intervalMinutes 必须是 1～1440 的整数" };
    }
    return { recur: `interval:${minutes}` };
  }
  return { recur: "none", error: "recurrence 只能是 none、daily、weekly、interval" };
}

function pendingAppointments(scope: MemoryScope): any[] {
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_appointments
       WHERE agent_id = ? AND user_id = ? AND status IN ('active','pending')
       ORDER BY due_at ASC`,
    )
    .all(scope.agentId, scope.userId) as any[];
}

function formatAppointmentListDue(row: any): string {
  const mode = String(row.time_mode || "exact").trim().toLowerCase();
  const eventDate = String(row.event_date || "").trim();
  if (mode === "date_only" && eventDate) {
    return `${formatDateOnlyLabel(eventDate)}（日程）`;
  }
  const due = new Date(String(row.due_at || ""));
  if (Number.isNaN(due.getTime())) return String(row.due_at || "");
  const parts = zonedParts(due, ZONE);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${parts.year}年${parts.month}月${parts.day}日 ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

/**
 * manage_alarm: create / list / delete on hippocampus_appointments.
 * Throws Error with a model-readable message on any failure — the tool layer
 * turns that into status=error so the model can never claim success.
 */
export function manageAlarm(input: ManageAlarmInput): ManageAlarmResult {
  const scope = memoryScope(input.agentId, input.userId);
  const action = String(input.action || "").trim().toLowerCase();
  const db = getDb();
  const now = input.now || new Date();

  if (action === "list") {
    const rows = pendingAppointments(scope);
    if (!rows.length) return { ok: true, message: "当前没有主动提醒。" };
    const lines = rows.map(
      (row) =>
        `[${row.id}] ${String(row.title || "主动提醒")} · ${formatAppointmentListDue(row)}` +
        recurListSuffix(row.recur),
    );
    return { ok: true, message: lines.join("\n") };
  }

  if (action === "delete") {
    const id = String(input.id || "").trim();
    if (!id) {
      throw new Error("删除主动提醒需要有效 ID（先 list 再把返回的 [id] 传给 delete）");
    }
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`找不到要取消的主动提醒 ID=${id}。请先 list 核对 ID。`);
    }
    const row = db
      .prepare("SELECT id, status FROM hippocampus_appointments WHERE id = ? AND agent_id = ? AND user_id = ?")
      .get(numericId, scope.agentId, scope.userId) as { id: number; status: string } | undefined;
    if (!row) {
      throw new Error(`找不到要取消的主动提醒 ID=${id}。请先 list 核对 ID。`);
    }
    if (["cancelled", "done", "delivered"].includes(String(row.status || "").toLowerCase())) {
      return { ok: true, message: `该主动提醒已不在进行中（${row.status}），无需再删。` };
    }
    db.prepare("UPDATE hippocampus_appointments SET status = 'cancelled' WHERE id = ?").run(
      row.id,
    );
    return { ok: true, appointmentId: row.id, message: `已取消主动提醒：${row.id}` };
  }

  if (action !== "create") {
    throw new Error("主动提醒 action 只能是 create、list、delete");
  }
  const timeMode = String(input.timeMode || "exact").trim().toLowerCase() || "exact";
  if (timeMode !== "exact" && timeMode !== "date_only") {
    throw new Error("timeMode 只能是 exact 或 date_only");
  }
  const title = String(input.title || "").trim() || "主动提醒";

  let dueAt: string;
  let recur: string;
  let eventDate = "";
  let allDay = 0;

  if (timeMode === "date_only") {
    eventDate = normalizeEventDate(String(input.eventDate || ""));
    if (!eventDate) {
      throw new Error(
        "date_only 必须传 eventDate（YYYY-MM-DD，东八区日历日）。例如下周三开会 → eventDate=该周三日期。",
      );
    }
    const fireAt = resolveDateOnlyFireAt(eventDate, now);
    dueAt = formatShanghaiIso(fireAt);
    recur = "none";
    allDay = 1;
  } else {
    const atMs = parseStartAt(String(input.startAt || ""));
    if (atMs === null) {
      throw new Error(
        "主动提醒 startAt 无法解析。请传带时区的 ISO-8601，例如 " +
          `${formatShanghaiIso(now)}；工具返回 Error 后必须重算再调用，禁止对用户声称已设置。`,
      );
    }
    if (atMs <= now.getTime()) {
      throw new Error(
        `主动提醒需要未来的 ISO-8601 时间（此刻是 ${formatShanghaiIso(now)}）。` +
          "请按「此刻 + 用户要求的延迟」重算 startAt 并再次调用；禁止对用户声称已设置。",
      );
    }
    const normalized = normalizeAlarmRecur(input.recurrence, input.intervalMinutes);
    if (normalized.error) throw new Error(normalized.error);
    recur = normalized.recur;
    dueAt = formatShanghaiIso(new Date(atMs));
  }

  // Hard dedup: same agent + title + recur (+ event_date for date_only) pending.
  for (const row of pendingAppointments(scope)) {
    const existingTitle = String(row.title || "").trim() || "主动提醒";
    const existingRecur = String(row.recur || "none").trim().toLowerCase();
    const existingMode = String(row.time_mode || "exact").trim().toLowerCase() || "exact";
    let sameCore = title === existingTitle && recur === existingRecur && timeMode === existingMode;
    if (timeMode === "date_only") {
      sameCore = sameCore && eventDate === String(row.event_date || "").trim();
    }
    if (sameCore) {
      return {
        ok: true,
        appointmentId: Number(row.id),
        message:
          `已有相同主动提醒，未重复创建：${title}（ID: ${row.id}，` +
          `${formatAppointmentListDue(row)}${recurListSuffix(existingRecur)}）。` +
          `直接告知用户已在提醒；不要再 create。`,
      };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO hippocampus_appointments
        (agent_id, user_id, title, due_at, all_day, recur, status, evidence, time_mode, event_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      scope.agentId,
      scope.userId,
      title,
      dueAt,
      allDay,
      recur,
      `用户请求主动提醒：${title}`,
      timeMode,
      eventDate,
      now.toISOString(),
    );
  const appointmentId = Number(info.lastInsertRowid);
  const dueLabel =
    timeMode === "date_only"
      ? `${formatDateOnlyLabel(eventDate)}（日程）`
      : formatAppointmentListDue({ ...({ due_at: dueAt }) });
  return {
    ok: true,
    appointmentId,
    message:
      `已设置主动提醒：${title}（ID: ${appointmentId}，${dueLabel}${recurListSuffix(recur)}）。` +
      "到期会在聊天里提醒。",
  };
}

/**
 * Roll the interval recurrence forward when consumed by the scheduler. Kept
 * next to the tool so the storage format has exactly one owner.
 */
export function nextIntervalDueAt(dueAt: string, recur: string, now: Date): string | null {
  return advanceRecurringDueAt(dueAt, recur, now);
}
