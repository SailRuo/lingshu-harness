import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  addGroupMember,
  createGroupSession,
  deleteGroupSession,
  getGroupSession,
  listGroupMembers,
  listGroupMessagesPage,
  listGroupSessions,
  markGroupRead,
  readGroupDigestCursor,
  readGroupAnchor,
  removeGroupMember,
  updateGroupSession,
} from "../services/groupChatRepository.js";
import { runGroupTurn } from "../services/groupChatService.js";
import { isAbortError } from "../services/chatStreamService.js";
import type { GroupChatEvent } from "../services/groupChatTypes.js";

const CreateGroupSchema = z.object({
  title: z.string().min(1).max(60),
  description: z.string().max(240).optional().default(""),
  memberAgentIds: z.array(z.number().int().positive()).min(2),
});

const UpdateGroupSchema = z.object({
  title: z.string().min(1).max(60).optional(),
  description: z.string().max(240).optional(),
});

const SendMessageSchema = z.object({
  message: z.string().min(1).max(4000),
  mentionedAgentIds: z.array(z.number().int().positive()).optional().default([]),
});

const MemberSchema = z.object({
  agentId: z.number().int().positive(),
});

function toGroupDetail(groupId: string) {
  const group = getGroupSession(groupId);
  if (!group) return null;
  return {
    group,
    members: listGroupMembers(groupId),
    anchor: readGroupAnchor(groupId),
  };
}

function sendError(reply: FastifyReply, error: unknown) {
  const statusCode = Number((error as any)?.statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    reply.code(statusCode).send({ detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  throw error;
}

export async function registerGroupChatRoutes(app: FastifyInstance) {
  app.get("/api/v1/group-chat/groups", async (req, reply) => {
    const userId = String((req.query as any)?.userId || "default_user");
    return listGroupSessions(userId);
  });

  app.post("/api/v1/group-chat/groups", async (req, reply) => {
    const parsed = CreateGroupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ detail: parsed.error.issues.map((issue) => issue.message).join("; ") });
      return;
    }
    try {
      const group = createGroupSession({
        title: parsed.data.title,
        description: parsed.data.description,
        memberAgentIds: parsed.data.memberAgentIds,
      });
      reply.code(201);
      return toGroupDetail(group.id);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get("/api/v1/group-chat/groups/:groupId", async (req, reply) => {
    const groupId = String((req.params as any).groupId);
    const detail = toGroupDetail(groupId);
    if (!detail) {
      reply.code(404).send({ detail: "群聊不存在" });
      return;
    }
    return detail;
  });

  app.patch("/api/v1/group-chat/groups/:groupId", async (req, reply) => {
    const parsed = UpdateGroupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ detail: parsed.error.issues.map((issue) => issue.message).join("; ") });
      return;
    }
    try {
      updateGroupSession(String((req.params as any).groupId), parsed.data);
      return toGroupDetail(String((req.params as any).groupId));
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.delete("/api/v1/group-chat/groups/:groupId", async (req, reply) => {
    try {
      deleteGroupSession(String((req.params as any).groupId));
      return { deleted: true };
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post("/api/v1/group-chat/groups/:groupId/members", async (req, reply) => {
    const parsed = MemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ detail: "invalid agentId" });
      return;
    }
    try {
      const result = addGroupMember(String((req.params as any).groupId), parsed.data.agentId);
      return { ...result, detail: toGroupDetail(String((req.params as any).groupId)) };
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.delete("/api/v1/group-chat/groups/:groupId/members/:agentId", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      reply.code(400).send({ detail: "invalid agentId" });
      return;
    }
    try {
      removeGroupMember(String((req.params as any).groupId), agentId);
      return { removed: true, detail: toGroupDetail(String((req.params as any).groupId)) };
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get("/api/v1/group-chat/groups/:groupId/messages", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const groupId = String((req.params as any).groupId);
    if (!getGroupSession(groupId)) {
      reply.code(404).send({ detail: "群聊不存在" });
      return;
    }
    try {
      return listGroupMessagesPage(groupId, {
        limit: query.limit === undefined ? 30 : Number(query.limit),
        beforeMessageId: query.beforeMessageId ? String(query.beforeMessageId) : undefined,
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post("/api/v1/group-chat/groups/:groupId/read", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const state = markGroupRead(
        String((req.params as any).groupId),
        "default_user",
        body.lastMessageId === undefined ? null : String(body.lastMessageId),
      );
      return { ...state, group: getGroupSession(String((req.params as any).groupId)) };
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post("/api/v1/group-chat/groups/:groupId/open", async (req, reply) => {
    const groupId = String((req.params as any).groupId);
    try {
      markGroupRead(groupId);
      const detail = toGroupDetail(groupId);
      if (!detail) {
        reply.code(404).send({ detail: "群聊不存在" });
        return;
      }
      return detail;
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get("/api/v1/group-chat/groups/:groupId/digest-state", async (req, reply) => {
    const groupId = String((req.params as any).groupId);
    if (!getGroupSession(groupId)) {
      reply.code(404).send({ detail: "群聊不存在" });
      return;
    }
    const members = listGroupMembers(groupId).map((member) => ({
      agentId: member.agentId,
      name: member.displayName || member.name,
      cursor: readGroupDigestCursor(groupId, member.agentId),
    }));
    return { groupId, members, anchor: readGroupAnchor(groupId) };
  });

  app.post("/api/v1/group-chat/groups/:groupId/messages", async (req, reply) => {
    const parsed = SendMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ detail: parsed.error.issues.map((issue) => issue.message).join("; ") });
      return;
    }
    const groupId = String((req.params as any).groupId);
    const controller = new AbortController();
    const res = reply.raw;
    const onClientClose = () => {
      if (!res.writableEnded) controller.abort(new DOMException("client_disconnected", "AbortError"));
    };
    res.on("close", onClientClose);

    const iterator = runGroupTurn({
      groupId,
      userText: parsed.data.message,
      mentionedAgentIds: parsed.data.mentionedAgentIds,
      signal: controller.signal,
    });

    let first: IteratorResult<GroupChatEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      res.off("close", onClientClose);
      sendError(reply, error);
      return;
    }

    reply.hijack();
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    try {
      if (!first.done) {
        res.write(`data: ${JSON.stringify(first.value)}\n\n`);
      }
      while (!first.done) {
        if (controller.signal.aborted) break;
        const next = await iterator.next();
        if (next.done) break;
        res.write(`data: ${JSON.stringify(next.value)}\n\n`);
      }
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) {
        const payload: GroupChatEvent = {
          type: "group.error",
          eventId: `sse-error-${Date.now()}`,
          groupSessionId: groupId,
          turnId: "",
          timestamp: new Date().toISOString(),
          content: error instanceof Error ? error.message : String(error),
          metadata: { phase: "sse" },
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } finally {
      res.off("close", onClientClose);
      if (!res.writableEnded) res.end();
    }
  });
}
