import { randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import type { ChatEvent } from "./chatStreamService.js";

export interface TaskRunRow {
  task_id: string;
  thread_id: number;
  message_id: number | null;
  mode: string;
  state: string;
  root_event_id: string | null;
  last_event_id: string | null;
  last_checkpoint_id: string | null;
  resume_count: number;
  title: string | null;
  workspace_path: string | null;
  request_text: string | null;
  started_at: string;
  interrupted_at: string | null;
  resumed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskEventResponse {
  eventId: string;
  taskId: string;
  parentEventId: string | null;
  depth: number;
  eventSequence: number;
  stepType: string;
  stepStatus: string | null;
  attemptNo: number;
  attemptGroupId: string | null;
  branchId: string | null;
  nodeName: string | null;
  payload: Record<string, unknown>;
  error: unknown;
  timestamp: string;
}

const activeTaskControllers = new Map<string, AbortController>();

export function normalizeTaskState(state: string | null | undefined): string {
  return String(state || "").trim() || "running";
}

export function createTaskRun(input: {
  taskId?: string;
  threadId: number;
  mode?: string;
  title?: string;
  requestText?: string;
  workspacePath?: string;
}): TaskRunRow {
  const db = getDb();
  const now = new Date().toISOString();
  const taskId = input.taskId || randomUUID();
  db.prepare(
    `INSERT INTO task_runs
      (task_id, thread_id, mode, state, title, workspace_path, request_text,
       started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       state = 'running', resumed_at = NULL, completed_at = NULL, updated_at = excluded.updated_at`,
  ).run(
    taskId,
    input.threadId,
    input.mode || "task",
    (input.title || input.requestText || "").slice(0, 255) || null,
    input.workspacePath || process.cwd(),
    input.requestText || null,
    now,
    now,
    now,
  );
  return getTaskRun(taskId)!;
}

export function getTaskRun(taskId: string): TaskRunRow | null {
  const row = getDb().prepare("SELECT * FROM task_runs WHERE task_id = ?").get(taskId) as
    | TaskRunRow
    | undefined;
  return row ?? null;
}

export function updateTaskRun(
  taskId: string,
  patch: Partial<
    Pick<
      TaskRunRow,
      | "state"
      | "message_id"
      | "root_event_id"
      | "last_event_id"
      | "last_checkpoint_id"
      | "resume_count"
      | "interrupted_at"
      | "resumed_at"
      | "completed_at"
    >
  >,
) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
  getDb()
    .prepare(`UPDATE task_runs SET ${assignments}, updated_at = ? WHERE task_id = ?`)
    .run(...entries.map(([, value]) => value), new Date().toISOString(), taskId);
}

export function maxTaskEventSequence(taskId: string): number {
  const row = getDb()
    .prepare("SELECT MAX(event_sequence) AS seq FROM task_events WHERE task_id = ?")
    .get(taskId) as { seq: number | null };
  return Number(row?.seq || 0);
}

export function appendTaskEvent(taskId: string, event: ChatEvent) {
  const db = getDb();
  const metadata = event.metadata || {};
  const nodeName = String(metadata.node_name || "").toLowerCase();
  const stepStatus = String(
    metadata.run_status ||
      metadata.stepStatus ||
      (event.type === "done" ? "done" : event.type === "error" ? "failed" : "running"),
  );
  const payload = {
    ...metadata,
    ...(event.content !== undefined && metadata.content === undefined ? { content: event.content } : {}),
  };
  const classification = String(metadata.result_classification || "").toLowerCase();
  const errorClass =
    String(
      metadata.error_class ||
        (event.type === "error" ? "failure" : "") ||
        (event.type === "tool_result" && classification && classification !== "success"
          ? classification
          : ""),
    ) || null;
  const errorJson =
    metadata.error_json ?? metadata.error ?? (event.type === "error" && event.content ? { message: event.content } : null);
  const stdoutPreview = String(metadata.stdout_preview || event.content || "").slice(0, 4000) || null;
  const stderrPreview = metadata.stderr_preview ? String(metadata.stderr_preview).slice(0, 4000) : null;
  const now = event.timestamp || new Date().toISOString();
  const mergeable = nodeName === "reflect" && ["thought", "state", "text_delta"].includes(event.type);
  if (mergeable && ["running", "started"].includes(stepStatus.toLowerCase())) {
    const last = db
      .prepare(
        `SELECT * FROM task_events WHERE task_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(taskId) as Record<string, any> | undefined;
    const lastNode = String(last?.node_name || "").toLowerCase();
    const lastStatus = String(last?.step_status || "").toLowerCase();
    const lastType = String(last?.step_type || "");
    const canMergeType =
      last &&
      lastNode === "reflect" &&
      ["thought", "state", "text_delta"].includes(lastType) &&
      ["running", "started"].includes(lastStatus) &&
      !(event.type === "text_delta" && lastType !== "text_delta") &&
      !(event.type !== "text_delta" && lastType === "text_delta");
    if (canMergeType) {
      const previousPayload = JSON.parse(last.payload_json || "{}");
      let mergedPayload = payload;
      let mergedStdout = stdoutPreview;
      if (event.type === "text_delta") {
        mergedPayload = {
          ...previousPayload,
          ...payload,
          content: `${String(previousPayload.content || "")}${String(payload.content || "")}`,
        };
        mergedStdout = `${String(last.stdout_preview || "")}${String(stdoutPreview || "")}`.slice(0, 4000) || null;
      }
      db.prepare(
        `UPDATE task_events SET
           event_sequence = ?, step_type = ?, step_status = ?, payload_json = ?,
           error_class = ?, error_json = ?, stdout_preview = ?, stderr_preview = ?,
           output_truncated = ?, output_bytes = ?, output_checksum = ?, artifact_ref = ?,
           created_at = ?
         WHERE event_id = ?`,
      ).run(
        event.eventSequence,
        event.type,
        stepStatus,
        JSON.stringify(mergedPayload),
        errorClass,
        errorJson ? JSON.stringify(errorJson) : null,
        mergedStdout,
        stderrPreview,
        metadata.output_truncated ? 1 : 0,
        metadata.output_bytes == null ? null : Number(metadata.output_bytes),
        metadata.output_checksum ? String(metadata.output_checksum) : null,
        metadata.artifact_ref ? String(metadata.artifact_ref) : null,
        now,
        last.event_id,
      );
      updateTaskRun(taskId, {
        ...(last.root_event_id ? {} : { root_event_id: last.event_id }),
        last_event_id: last.event_id,
      });
      return;
    }
  }

  const info = db.prepare(
    `INSERT OR IGNORE INTO task_events
      (event_id, task_id, parent_event_id, depth, event_sequence, step_type, step_status,
       attempt_no, attempt_group_id, branch_id, node_name, error_class, payload_json, error_json,
       stdout_preview, stderr_preview, output_truncated, output_bytes, output_checksum, artifact_ref,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId,
    taskId,
    event.parentEventId || null,
    Number(event.depth || 0),
    event.eventSequence,
    event.type,
    stepStatus,
    Number(event.attemptNo || 1),
    event.attemptGroupId || null,
    event.branchId || null,
    String(metadata.node_name || "") || null,
    errorClass,
    JSON.stringify(payload),
    errorJson ? JSON.stringify(errorJson) : null,
    stdoutPreview,
    stderrPreview,
    metadata.output_truncated ? 1 : 0,
    metadata.output_bytes == null ? null : Number(metadata.output_bytes),
    metadata.output_checksum ? String(metadata.output_checksum) : null,
    metadata.artifact_ref ? String(metadata.artifact_ref) : null,
    now,
  );
  let persistedEventId = event.eventId;
  if (!info.changes) {
    const existing = db
      .prepare("SELECT event_id FROM task_events WHERE task_id = ? AND event_sequence = ?")
      .get(taskId, event.eventSequence) as { event_id: string } | undefined;
    if (existing) persistedEventId = existing.event_id;
  }
  const task = getTaskRun(taskId);
  updateTaskRun(taskId, {
    ...(task?.root_event_id ? {} : { root_event_id: persistedEventId }),
    last_event_id: persistedEventId,
  });
}

export function listTaskEvents(taskId: string): TaskEventResponse[] {
  const rows = getDb()
    .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY event_sequence ASC")
    .all(taskId) as Record<string, any>[];
  return rows.map((row) => ({
    eventId: row.event_id,
    taskId: row.task_id,
    parentEventId: row.parent_event_id,
    depth: row.depth,
    eventSequence: row.event_sequence,
    stepType: row.step_type,
    stepStatus: row.step_status,
    attemptNo: row.attempt_no,
    attemptGroupId: row.attempt_group_id,
    branchId: row.branch_id,
    nodeName: row.node_name,
    payload: row.payload_json ? JSON.parse(row.payload_json) : {},
    error: row.error_json ? JSON.parse(row.error_json) : null,
    timestamp: row.created_at,
  }));
}

export function runStateToTaskStatus(state: string): "running" | "interrupted" | "resumed" | "done" | "failed" | "canceled" {
  if (["running", "interrupted", "resumed", "done", "failed", "canceled"].includes(state)) {
    return state as any;
  }
  return "running";
}

export function saveTaskCheckpoint(
  taskId: string,
  eventSequence: number,
  stateSnapshot: unknown,
  pendingQueue: unknown,
): string {
  const db = getDb();
  const now = new Date().toISOString();
  const snapshot = JSON.stringify(stateSnapshot ?? {});
  const queue = JSON.stringify(pendingQueue ?? []);
  const existing = db
    .prepare(
      "SELECT checkpoint_id FROM task_checkpoints WHERE task_id = ? AND event_sequence = ?",
    )
    .get(taskId, eventSequence) as { checkpoint_id: string } | undefined;
  const checkpointId = existing?.checkpoint_id || randomUUID();
  if (existing) {
    db.prepare(
      `UPDATE task_checkpoints SET state_snapshot_json = ?, pending_queue_json = ?, created_at = ?
       WHERE task_id = ? AND event_sequence = ?`,
    ).run(snapshot, queue, now, taskId, eventSequence);
  } else {
    db.prepare(
      `INSERT INTO task_checkpoints
        (checkpoint_id, task_id, event_sequence, state_snapshot_json, pending_queue_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(checkpointId, taskId, eventSequence, snapshot, queue, now);
  }
  updateTaskRun(taskId, { last_checkpoint_id: checkpointId });
  return checkpointId;
}

export function getLatestCheckpoint(taskId: string): {
  checkpoint_id: string;
  event_sequence: number | null;
  state_snapshot_json: string | null;
  pending_queue_json: string | null;
} | null {
  const row = getDb()
    .prepare(
      "SELECT checkpoint_id, event_sequence, state_snapshot_json, pending_queue_json FROM task_checkpoints WHERE task_id = ? ORDER BY event_sequence DESC, created_at DESC LIMIT 1",
    )
    .get(taskId) as any;
  return row ?? null;
}

export function registerTaskController(taskId: string, controller: AbortController) {
  activeTaskControllers.set(taskId, controller);
}

export function unregisterTaskController(taskId: string, controller: AbortController) {
  if (activeTaskControllers.get(taskId) === controller) {
    activeTaskControllers.delete(taskId);
  }
}

export function cancelTaskRun(taskId: string): TaskRunRow | null {
  const task = getTaskRun(taskId);
  if (!task) return null;
  if (["done", "failed", "canceled"].includes(task.state)) return task;
  updateTaskRun(taskId, {
    state: "canceled",
    completed_at: new Date().toISOString(),
  });
  const controller = activeTaskControllers.get(taskId);
  if (controller) {
    controller.abort(new DOMException("task_canceled", "AbortError"));
  }
  return getTaskRun(taskId);
}

export function resumeTaskRun(taskId: string): TaskRunRow | null {
  const task = getTaskRun(taskId);
  if (!task) return null;
  if (task.state !== "interrupted") return null;
  updateTaskRun(taskId, {
    state: "resumed",
    resume_count: task.resume_count + 1,
    resumed_at: new Date().toISOString(),
    completed_at: null,
  });
  return getTaskRun(taskId);
}

export function findApprovalDecision(
  taskId: string,
  callId: string,
): { approved: boolean; reason?: string } | null {
  const rows = getDb()
    .prepare(
      "SELECT payload_json FROM task_events WHERE task_id = ? AND step_type = 'approval_resolved' ORDER BY event_sequence DESC",
    )
    .all(taskId) as { payload_json: string | null }[];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json || "{}");
      if (payload.call_id !== callId) continue;
      return {
        approved: payload.resolution === "approved",
        ...(payload.reject_reason ? { reason: String(payload.reject_reason) } : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function appendTaskDoneEvent(taskId: string, state: "done" | "failed" | "canceled") {
  const sequence = maxTaskEventSequence(taskId) + 1;
  const eventId = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO task_events
        (event_id, task_id, parent_event_id, depth, event_sequence, step_type, step_status,
         attempt_no, node_name, payload_json, created_at)
       VALUES (?, ?, NULL, 0, ?, 'done', ?, 1, 'reflect', ?, ?)`,
    )
    .run(
      eventId,
      taskId,
      sequence,
      state,
      JSON.stringify({ run_status: state, node_name: "reflect" }),
      now,
    );
  const task = getTaskRun(taskId);
  updateTaskRun(taskId, {
    ...(task?.root_event_id ? {} : { root_event_id: eventId }),
    last_event_id: eventId,
  });
  return eventId;
}

export function recordApprovalEvent(
  taskId: string,
  callId: string,
  approved: boolean,
  rejectReason?: string,
) {
  const sequence = maxTaskEventSequence(taskId) + 1;
  const eventId = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO task_events
        (event_id, task_id, parent_event_id, depth, event_sequence, step_type, step_status,
         attempt_no, node_name, payload_json, created_at)
       VALUES (?, ?, NULL, 2, ?, 'approval_resolved', ?, 1, 'approval', ?, ?)`,
    )
    .run(
      eventId,
      taskId,
      sequence,
      approved ? "completed" : "canceled",
      JSON.stringify({
        call_id: callId,
        resolution: approved ? "approved" : "rejected",
        ...(rejectReason ? { reject_reason: rejectReason } : {}),
      }),
      now,
    );
  const task = getTaskRun(taskId);
  updateTaskRun(taskId, {
    ...(task?.root_event_id ? {} : { root_event_id: eventId }),
    last_event_id: eventId,
  });
}
