import { getDb } from "../db/sqlite.js";
import { getAgent } from "./agentService.js";
import { logTick } from "./memoryScope.js";
import {
  advanceRecurringDueAt,
  isAppointmentDueForDelivery,
} from "./memoryService.js";
import {
  deliverProactiveMessage,
  getProactiveConfig,
  isProactiveDndActive,
  proactiveTick,
  setProactiveSchedulerRunning,
} from "./proactiveService.js";
import {
  consolidateDaily,
  consolidatePeriodPortraitsAfterDigest,
  listTimeMirrorScopes,
} from "./witnessService.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { recoverPendingDigests } from "./digestScheduler.js";
import { dayKey, wallTimeToUtc, zonedParts, type ZonedParts } from "./memoryTime.js";
import { mergeSelfStateMonth, runSelfStateDailyRollup } from "./selfStateDailyService.js";
import { mergeAffectMonth, runAffectDailyRollup } from "./affectDailyService.js";
import { purgeExpiredBackgroundTaskEvents } from "./backgroundTaskEvents.js";

let proactiveTimer: NodeJS.Timeout | null = null;
let appointmentTimer: NodeJS.Timeout | null = null;
let arcTimer: NodeJS.Timeout | null = null;
let digestRecoveryTimer: NodeJS.Timeout | null = null;
let selfStateDailyTimer: NodeJS.Timeout | null = null;
let selfStateCatchupTimer: NodeJS.Timeout | null = null;
let backgroundTaskRetentionTimer: NodeJS.Timeout | null = null;
let lastSelfStateDailyDay: string | null = null;
let lastSelfStateMergeMonth: string | null = null;
let started = false;
let running = false;

function scheduleProactiveTick() {
  const seconds = Math.max(30, Number(getProactiveConfig().tickSeconds || 300));
  proactiveTimer = setTimeout(async () => {
    proactiveTimer = null;
    try {
      await proactiveTick();
    } finally {
      if (running) scheduleProactiveTick();
    }
  }, seconds * 1000);
  proactiveTimer.unref?.();
}

function shiftZonedDate(parts: ZonedParts, days: number, months: number, years: number): ZonedParts {
  const shifted = new Date(
    Date.UTC(
      parts.year + years,
      parts.month - 1 + months,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

function advanceDueAt(dueAt: string, recur: string | null, now: Date): string | null {
  // Python `appointments.advance_recurring_due_at`: roll the due date forward
  // period by period until it is in the future (a single step is not enough —
  // a recurring appointment that was missed for several days must skip every
  // elapsed occurrence, otherwise it re-fires once a day forever).
  return advanceRecurringDueAt(dueAt, recur, now);
}

async function generateReminderText(agentId: number, title: string) {
  const agent = getAgent(agentId);
  const name = agent?.displayName || agent?.name || "助手";
  const cfg = getLLMConfig("chat");
  if (!cfg.model || !cfg.baseUrl) return `记得今天的约定：${title}。`;
  try {
    const client = createOpenAIClient(cfg);
    const response = await createCompletionWithThinkingFallback(
      client,
      {
        model: cfg.model,
        messages: [
          {
            role: "system",
            content: `你是「${name}」。提醒用户之前约好的事。自然、简短、像你真的记着，不要提系统、提醒器或 AI。`,
          },
          { role: "user", content: `约定：${title}` },
        ],
        temperature: 0.7,
        ...buildThinkingParams(cfg),
      },
      cfg,
    );
    return (
      String(response.choices?.[0]?.message?.content || "").trim() || `记得今天的约定：${title}。`
    );
  } catch {
    return `记得今天的约定：${title}。`;
  }
}

async function deliverDueAppointments() {
  // Same quiet-hours gate as proactive outreach: do not wake the user at night.
  // Python gates appointment reminders through `check_proactive_allowed`, which
  // applies the same DND window before the `appointment_reminder` short-circuit.
  if (isProactiveDndActive()) return;
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const rows = (
    db
      .prepare(
        `SELECT * FROM hippocampus_appointments
         WHERE status IN ('active','pending') AND due_at IS NOT NULL AND due_at <= ?
         ORDER BY due_at ASC LIMIT 200`,
      )
      .all(nowIso) as any[]
  ).slice(0, 20);
  for (const row of rows) {
    const scope = { agentId: Number(row.agent_id), userId: String(row.user_id) };
    const dueAt = new Date(String(row.due_at));
    // De-dup window is the appointment's own day, not "today"
    // (Python `_is_due_for_active_delivery`).
    if (!isAppointmentDueForDelivery(dueAt, row.last_delivered_at, now, row.recur)) {
      // Already delivered for this occurrence: roll the recurrence forward so
      // the scan stops re-firing it. `now + 1s` guarantees at least one step.
      const nextDue = advanceDueAt(
        String(row.due_at),
        row.recur,
        new Date(now.getTime() + 1000),
      );
      if (nextDue && nextDue !== String(row.due_at)) {
        db.prepare(
          "UPDATE hippocampus_appointments SET due_at = ?, status = 'active' WHERE id = ?",
        ).run(nextDue, row.id);
      } else if (!nextDue) {
        // One-shot appointment that was already delivered: close it.
        db.prepare(
          "UPDATE hippocampus_appointments SET status = 'delivered' WHERE id = ?",
        ).run(row.id);
      }
      continue;
    }
    try {
      const text = await generateReminderText(scope.agentId, String(row.title || ""));
      const delivered = await deliverProactiveMessage(scope.agentId, text, {
        userId: scope.userId,
        messageKind: "appointment_reminder",
      });
      if (!delivered) {
        logTick(scope, "appointment_reminder", "nothing", {
          appointmentId: row.id,
          reason: "no_delivery_route",
        });
        continue;
      }
      // Roll strictly past `now` so the next occurrence is a different one.
      const nextDue = advanceDueAt(
        String(row.due_at),
        row.recur,
        new Date(now.getTime() + 1000),
      );
      db.prepare(
        `UPDATE hippocampus_appointments SET last_delivered_at = ?,
           status = ?, due_at = COALESCE(?, due_at) WHERE id = ?`,
      ).run(
        nowIso,
        nextDue ? "active" : "delivered",
        nextDue,
        row.id,
      );
      logTick(scope, "appointment_reminder", "delivered", {
        appointmentId: row.id,
        title: row.title,
        channel: delivered.channel,
      });
    } catch (error) {
      logTick(
        scope,
        "appointment_reminder",
        "failed",
        { appointmentId: row.id },
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function scheduleAppointmentScan() {
  appointmentTimer = setTimeout(async () => {
    appointmentTimer = null;
    try {
      await deliverDueAppointments();
    } finally {
      if (running) scheduleAppointmentScan();
    }
  }, 60_000);
  appointmentTimer.unref?.();
}

function nextDisplayWallClockDelayMs(hour: number, minute: number): number {
  const now = new Date();
  const parts = zonedParts(now);
  const today = wallTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    second: 0,
    weekday: parts.weekday,
  });
  let next = today;
  if (next.getTime() <= now.getTime()) {
    const tomorrow = shiftZonedDate(parts, 1, 0, 0);
    next = wallTimeToUtc({ ...tomorrow, hour, minute, second: 0 });
  }
  return Math.max(60_000, next.getTime() - now.getTime());
}

function nextArcDelayMs() {
  return nextDisplayWallClockDelayMs(4, 10);
}

function scheduleDailyArc() {
  arcTimer = setTimeout(async () => {
    arcTimer = null;
    try {
      for (const scope of listTimeMirrorScopes()) {
        try {
          await consolidatePeriodPortraitsAfterDigest(scope);
          await consolidateDaily(scope);
        } catch (error) {
          logTick(
            scope,
            "witness_arc",
            "nothing",
            { source: "daily" },
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      if (running) scheduleDailyArc();
    }
  }, nextArcDelayMs());
  arcTimer.unref?.();
}

const SELF_STATE_DAILY_HOUR = 3;
const SELF_STATE_MERGE_DAY = 5;

function nextSelfStateDailyDelayMs() {
  return nextDisplayWallClockDelayMs(SELF_STATE_DAILY_HOUR, 0);
}

function previousLocalDayKey() {
  const now = new Date();
  const parts = zonedParts(now);
  const yesterday = shiftZonedDate({ ...parts, hour: 12, minute: 0, second: 0 }, -1, 0, 0);
  return dayKey(wallTimeToUtc(yesterday));
}

function logSelfStateDailySummary(summary: ReturnType<typeof runSelfStateDailyRollup>) {
  for (const item of summary.writtenScopes) {
    logTick(item.scope, "self_state_daily", "rolled", {
      day: summary.day,
      sampleCount: item.sampleCount,
    });
  }
  for (const failure of summary.failures) {
    logTick(failure.scope, "self_state_daily", "failed", { day: summary.day }, failure.error);
  }
}

function runPreviousMonthRollup(now: Date) {
  const parts = zonedParts(now);
  const year = parts.month === 1 ? parts.year - 1 : parts.year;
  const month = parts.month === 1 ? 12 : parts.month - 1;
  try {
    const result = mergeSelfStateMonth(year, month);
    console.info("[self_state_daily] closed month merged", {
      year,
      month,
      ...result,
    });
  } catch (error) {
    console.warn("[self_state_daily] closed month merge failed", {
      year,
      month,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const result = mergeAffectMonth(year, month);
    console.info("[affect_daily] closed month merged", {
      year,
      month,
      ...result,
    });
  } catch (error) {
    console.warn("[affect_daily] closed month merge failed", {
      year,
      month,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runSelfStateDailyJob() {
  const now = new Date();
  const targetDay = previousLocalDayKey();
  if (lastSelfStateDailyDay !== targetDay) {
    lastSelfStateDailyDay = targetDay;
    logSelfStateDailySummary(runSelfStateDailyRollup(targetDay));
    const affectSummary = runAffectDailyRollup(targetDay);
    if (affectSummary.written || affectSummary.failed) {
      console.info("[affect_daily] rolled", affectSummary);
    }
  }
  // Python merges the closed month on the 5th at 03:00; roll the whole month too.
  const parts = zonedParts(now);
  if (parts.day === SELF_STATE_MERGE_DAY) {
    const monthKey = `${parts.year}-${parts.month}`;
    if (lastSelfStateMergeMonth !== monthKey) {
      lastSelfStateMergeMonth = monthKey;
      runPreviousMonthRollup(now);
    }
  }
}

function scheduleSelfStateDaily() {
  selfStateDailyTimer = setTimeout(() => {
    selfStateDailyTimer = null;
    try {
      runSelfStateDailyJob();
    } catch (error) {
      console.warn("[self_state_daily] rollup failed", error);
    } finally {
      if (running) scheduleSelfStateDaily();
    }
  }, nextSelfStateDailyDelayMs());
  selfStateDailyTimer.unref?.();
}

/** Desktop apps are often closed at 03:00; run the missed pass shortly after launch. */
function scheduleSelfStateCatchUp() {
  selfStateCatchupTimer = setTimeout(() => {
    selfStateCatchupTimer = null;
    try {
      runSelfStateDailyJob();
    } catch (error) {
      console.warn("[self_state_daily] catch-up failed", error);
    }
  }, 15_000);
  selfStateCatchupTimer.unref?.();
}

function scheduleDigestRecovery() {
  digestRecoveryTimer = setTimeout(() => {
    digestRecoveryTimer = null;
    try {
      recoverPendingDigests();
    } finally {
      if (running) scheduleDigestRecovery();
    }
  }, 15 * 60_000);
  digestRecoveryTimer.unref?.();
}

/**
 * background_task_events retention (decided 2026-11-15): keep only the most
 * recent week. Runs once at startup (desktop apps are closed most of the day)
 * and then once a day. The purge itself is never recorded back into the table —
 * only a console summary.
 */
function runBackgroundTaskEventRetention() {
  try {
    const result = purgeExpiredBackgroundTaskEvents();
    if (result.deleted > 0) {
      console.info("[background_task_events] retention purge", result);
    }
  } catch (error) {
    console.warn(
      "[background_task_events] retention purge failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const BACKGROUND_TASK_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

function scheduleBackgroundTaskRetention() {
  backgroundTaskRetentionTimer = setTimeout(() => {
    backgroundTaskRetentionTimer = null;
    try {
      runBackgroundTaskEventRetention();
    } finally {
      if (running) scheduleBackgroundTaskRetention();
    }
  }, BACKGROUND_TASK_RETENTION_INTERVAL_MS);
  backgroundTaskRetentionTimer.unref?.();
}

export function startInnerLifeScheduler() {
  if (started) return;
  started = true;
  running = true;
  setProactiveSchedulerRunning(true);
  recoverPendingDigests();
  scheduleDigestRecovery();
  scheduleProactiveTick();
  scheduleAppointmentScan();
  scheduleDailyArc();
  scheduleSelfStateDaily();
  scheduleSelfStateCatchUp();
  runBackgroundTaskEventRetention();
  scheduleBackgroundTaskRetention();
}

export function stopInnerLifeScheduler() {
  running = false;
  started = false;
  setProactiveSchedulerRunning(false);
  if (proactiveTimer) clearTimeout(proactiveTimer);
  if (appointmentTimer) clearTimeout(appointmentTimer);
  if (arcTimer) clearTimeout(arcTimer);
  if (digestRecoveryTimer) clearTimeout(digestRecoveryTimer);
  if (selfStateDailyTimer) clearTimeout(selfStateDailyTimer);
  if (selfStateCatchupTimer) clearTimeout(selfStateCatchupTimer);
  if (backgroundTaskRetentionTimer) clearTimeout(backgroundTaskRetentionTimer);
  proactiveTimer = null;
  appointmentTimer = null;
  arcTimer = null;
  digestRecoveryTimer = null;
  selfStateDailyTimer = null;
  selfStateCatchupTimer = null;
  backgroundTaskRetentionTimer = null;
}

export function innerLifeSchedulerState() {
  return {
    running,
    proactiveScheduled: Boolean(proactiveTimer),
    appointmentsScheduled: Boolean(appointmentTimer),
    arcScheduled: Boolean(arcTimer),
    digestRecoveryScheduled: Boolean(digestRecoveryTimer),
    selfStateDailyScheduled: Boolean(selfStateDailyTimer),
    selfStateCatchUpScheduled: Boolean(selfStateCatchupTimer),
    backgroundTaskRetentionScheduled: Boolean(backgroundTaskRetentionTimer),
  };
}
