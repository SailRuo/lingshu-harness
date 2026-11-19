import type { FastifyInstance } from "fastify";
import {
  appendTaskDoneEvent,
  cancelTaskRun,
  getLatestCheckpoint,
  getTaskRun,
  listTaskEvents,
  resumeTaskRun,
  updateTaskRun,
} from "../services/taskService.js";

export async function registerTaskRoutes(app: FastifyInstance) {
  app.get("/api/v1/tasks/:taskId/events", async (req, reply) => {
    const taskId = String((req.params as any).taskId || "");
    const task = getTaskRun(taskId);
    if (!task) {
      reply.code(404).send({ detail: "Task not found" });
      return;
    }
    const events = listTaskEvents(taskId);
    if (!events.length) {
      reply.code(404).send({ detail: "Task events not found" });
      return;
    }
    return events;
  });

  app.post("/api/v1/tasks/:taskId/resume", async (req, reply) => {
    const taskId = String((req.params as any).taskId || "");
    const task = getTaskRun(taskId);
    if (!task) {
      reply.code(404).send({ detail: "Task not found" });
      return;
    }
    if (task.state !== "interrupted") {
      reply.code(409).send({ detail: "Only interrupted tasks can be resumed" });
      return;
    }
    const checkpoint = getLatestCheckpoint(taskId);
    if (!checkpoint) {
      updateTaskRun(taskId, { state: "failed", completed_at: new Date().toISOString() });
      reply.code(409).send({ detail: "Task checkpoint is missing" });
      return;
    }
    const resumed = resumeTaskRun(taskId);
    return {
      taskId,
      state: resumed?.state || "resumed",
      action: "resume",
      accepted: true,
      timestamp: new Date().toISOString(),
      checkpointData: {
        checkpointId: checkpoint.checkpoint_id,
        eventSequence: checkpoint.event_sequence,
        stateSnapshot: checkpoint.state_snapshot_json
          ? JSON.parse(checkpoint.state_snapshot_json)
          : {},
        pendingQueue: checkpoint.pending_queue_json
          ? JSON.parse(checkpoint.pending_queue_json)
          : [],
        resumeCount: resumed?.resume_count ?? task.resume_count + 1,
        lastEventId: task.last_event_id,
      },
    };
  });

  app.post("/api/v1/tasks/:taskId/cancel", async (req, reply) => {
    const taskId = String((req.params as any).taskId || "");
    const task = getTaskRun(taskId);
    if (!task) {
      reply.code(404).send({ detail: "Task not found" });
      return;
    }
    if (["done", "failed", "canceled"].includes(task.state)) {
      reply.code(409).send({ detail: `Task is already ${task.state}` });
      return;
    }
    const previousState = task.state;
    cancelTaskRun(taskId);
    if (previousState === "interrupted") {
      appendTaskDoneEvent(taskId, "canceled");
    }
    return {
      taskId,
      state: "canceled",
      action: "cancel",
      accepted: true,
      timestamp: new Date().toISOString(),
    };
  });
}
