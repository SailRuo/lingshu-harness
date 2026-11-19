import type { FastifyInstance } from "fastify";
import { getDb } from "../db/sqlite.js";
import type { MemoryScope } from "../services/memoryService.js";
import {
  clearAllMemory,
  clearStreams,
  clearTickLog,
  createSeed,
  ensureDefaultSeeds,
  deleteConstraint,
  deleteSeed,
  deleteStream,
  generateSeedDraft,
  getAffectTimeline,
  getBaseline,
  getMemoryTurn,
  getMirror,
  getOverview,
  getRecallTrace,
  getRetrospect,
  getSelfState,
  getStats,
  getStreamDetail,
  listAppointments,
  listConstraints,
  listFacts,
  listMemoryThreads,
  listMemoryTurns,
  listRecallEvents,
  listRetrospectBuckets,
  listSeedChangeHistory,
  listSeedVersions,
  listSeeds,
  listStreams,
  listTickLog,
  memoryGraph,
  memoryScope,
  reactivateSeed,
  rebuildStreamEmbeddings,
  recallDebug,
  recomputeRetrospect,
  relinkStreams,
  restoreDefaultSeeds,
  retireSeed,
  seedGraph,
  seedWakeProbe,
  streamCluster,
  streamGraph,
  subscribeRecallEvents,
  subscribeTickLog,
  updateSeed,
} from "../services/memoryService.js";
import {
  buildHumanReport,
  buildJsonRecord,
  recallSessionKey,
} from "../services/recallReport.js";
import { queryEmbeddingCacheStats } from "../services/embeddingService.js";
import { readSelfStateHistory } from "../services/selfStateDailyService.js";
import {
  getSelfPortrait,
  refreshConversationAnchor,
} from "../services/conversationAnchorService.js";

function scopeFromQuery(req: any, reply: any): MemoryScope | null {
  const query = req.query as Record<string, any>;
  const agentId = Number(query.agentId);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    reply.code(400).send({ detail: "agentId is required" });
    return null;
  }
  return memoryScope(agentId, query.userId);
}

/**
 * Scope for routes that address a record by its own id.
 *
 * The agent scope is optional here: the record is looked up by id, so the
 * scope only matters as a fallback for the agent that owns it. Python's
 * equivalents do not take an agent scope at all.
 */
function optionalScopeFromQuery(req: any): MemoryScope {
  const query = req.query as Record<string, any>;
  const agentId = Number(query.agentId);
  const resolvedAgentId = Number.isInteger(agentId) && agentId > 0 ? agentId : 1;
  return memoryScope(resolvedAgentId, query.userId);
}

function scopeFromBodyOrQuery(req: any, reply: any): MemoryScope | null {
  const body = (req.body ?? {}) as Record<string, any>;
  const query = req.query as Record<string, any>;
  const agentId = Number(body.agentId ?? query.agentId);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    reply.code(400).send({ detail: "agentId is required" });
    return null;
  }
  return memoryScope(agentId, body.userId ?? query.userId);
}

function arrayParam(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

function sendSeedError(reply: any, error: any) {
  const code = String(error?.code || error?.message || "error");
  if (code === "not_found") {
    reply.code(404).send({ detail: "not_found" });
    return;
  }
  reply.code(400).send({ detail: code });
}

export async function registerMemoryRoutes(app: FastifyInstance) {
  app.get("/api/v1/memory/overview", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    await ensureDefaultSeeds(scope);
    return getOverview(scope);
  });

  /** Read-only self portrait + the conversation anchor that produced it. */
  app.get("/api/v1/memory/self-portrait", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return getSelfPortrait(scope);
  });

  /** Debug/acceptance hook: force one anchor compaction for a thread/scope. */
  app.post("/api/v1/memory/conversation-anchor/refresh", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    const body = (req.body ?? {}) as Record<string, any>;
    const query = req.query as Record<string, any>;
    const threadIdRaw = body.threadId ?? query.threadId;
    const threadId = Number(threadIdRaw);
    const target =
      Number.isInteger(threadId) && threadId > 0 ? threadId : scope;
    if (typeof target === "number") {
      // Verify the thread belongs to the requested scope; otherwise a debug
      // call could compact another companion's conversation.
      const row = getDb()
        .prepare("SELECT agent_id, user_id FROM chat_threads WHERE id = ?")
        .get(target) as { agent_id: number; user_id: string } | undefined;
      if (!row || row.agent_id !== scope.agentId || row.user_id !== scope.userId) {
        reply.code(404).send({ detail: "thread_not_found" });
        return;
      }
    }
    return refreshConversationAnchor(target, { force: true });
  });

  app.get("/api/v1/memory/streams", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const query = req.query as Record<string, any>;
    try {
      return await listStreams({
        ...scope,
        type: query.type ? String(query.type) : undefined,
        about: query.about ? String(query.about) : undefined,
        q: query.q ? String(query.q) : undefined,
        vector: String(query.vector || "").toLowerCase() === "true",
        limit: query.limit ? Number(query.limit) : undefined,
      });
    } catch (error: any) {
      const code = String(error?.code || error?.message || "");
      if (code === "vector_search_requires_q") {
        reply.code(400).send({ detail: code });
        return;
      }
      throw error;
    }
  });

  app.get("/api/v1/memory/streams/recall-debug", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const q = String((req.query as any).q || "").trim();
    if (!q) {
      reply.code(400).send({ detail: "q is required" });
      return;
    }
    return recallDebug(scope, q);
  });

  app.get("/api/v1/memory/streams/graph", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return streamGraph(scope);
  });

  app.post("/api/v1/memory/streams/clear", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    return clearStreams(scope);
  });

  app.post("/api/v1/memory/streams/relink", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    const batchLimit = Number((req.body as any)?.batchLimit ?? (req.query as any).batchLimit ?? 500);
    return relinkStreams(scope, batchLimit);
  });

  app.post("/api/v1/memory/streams/rebuild-embeddings", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    try {
      await rebuildStreamEmbeddings(scope, (payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      });
    } catch (error) {
      res.write(
        `data: ${JSON.stringify({
          phase: "done",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        })}\n\n`,
      );
    } finally {
      res.end();
    }
  });

  // The narrative cluster and the stream detail are addressed by stream id
  // alone — the GUI reaches them from a deep link that carries no agent
  // scope. The Python backend resolves both by id as well.
  app.get("/api/v1/memory/streams/:streamId/cluster", async (req, reply) => {
    const scope = optionalScopeFromQuery(req);
    const streamId = String((req.params as any).streamId);
    const result = streamCluster(scope, streamId);
    if (!result) {
      reply.code(404).send({ detail: "not_found" });
      return;
    }
    return result;
  });

  app.get("/api/v1/memory/streams/:streamId", async (req, reply) => {
    const scope = optionalScopeFromQuery(req);
    const result = getStreamDetail(scope, String((req.params as any).streamId));
    if (!result) {
      reply.code(404).send({ detail: "not_found" });
      return;
    }
    return result;
  });

  app.delete("/api/v1/memory/streams/:streamId", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const deleted = deleteStream(scope, String((req.params as any).streamId));
    if (!deleted) {
      reply.code(404).send({ detail: "not_found" });
      return;
    }
    return { status: "ok" };
  });

  app.get("/api/v1/memory/seeds", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const query = req.query as Record<string, any>;
    return listSeeds({
      ...scope,
      subject: query.subject ? String(query.subject) : undefined,
      source: query.source ? String(query.source) : undefined,
      q: query.q ? String(query.q) : undefined,
      status: query.status ? String(query.status) as "active" | "retired" | "all" : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  app.get("/api/v1/memory/seeds/changes", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listSeedChangeHistory(
      scope,
      undefined,
      Number((req.query as any).limit || 200),
    );
  });

  app.get("/api/v1/memory/seeds/graph", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return seedGraph(scope);
  });

  app.get("/api/v1/memory/seeds/wake-probe", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const q = String((req.query as any).q || "").trim();
    if (!q) {
      reply.code(400).send({ detail: "q is required" });
      return;
    }
    return seedWakeProbe(
      scope,
      q,
      Number((req.query as any).limit || 50),
      (req.query as any).source ? String((req.query as any).source) : null,
    );
  });

  app.post("/api/v1/memory/seeds/generate-draft", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      return await generateSeedDraft(String(body.draft || ""));
    } catch (error: any) {
      const code = String(error?.code || error?.message || "");
      if (code === "draft_too_short" || code === "parse_failed" || code === "draft_incomplete") {
        reply.code(400).send({ detail: code });
        return;
      }
      reply.code(500).send({ detail: code });
    }
  });

  app.post("/api/v1/memory/seeds", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    try {
      const item = await createSeed(scope, (req.body ?? {}) as Record<string, any>);
      return { item, status: "ok" };
    } catch (error) {
      sendSeedError(reply, error);
    }
  });

  app.put("/api/v1/memory/seeds/:seedId", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    try {
      const item = await updateSeed(scope, String((req.params as any).seedId), (req.body ?? {}) as any);
      return { item, status: "ok" };
    } catch (error) {
      sendSeedError(reply, error);
    }
  });

  app.delete("/api/v1/memory/seeds/:seedId", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    try {
      deleteSeed(scope, String((req.params as any).seedId));
      return { status: "ok" };
    } catch (error) {
      sendSeedError(reply, error);
    }
  });

  app.post("/api/v1/memory/seeds/:seedId/retire", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      const result = retireSeed(scope, String((req.params as any).seedId), {
        reason: String(body.reason || ""),
        evidenceRefs: Array.isArray(body.evidenceRefs)
          ? body.evidenceRefs.map(String)
          : Array.isArray(body.evidence_refs)
            ? body.evidence_refs.map(String)
            : [],
      });
      return { status: "ok", ...result };
    } catch (error) {
      sendSeedError(reply, error);
    }
  });

  app.post("/api/v1/memory/seeds/:seedId/reactivate", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    const body = (req.body ?? {}) as Record<string, any>;
    try {
      const result = reactivateSeed(scope, String((req.params as any).seedId), {
        reason: String(body.reason || ""),
        evidenceRefs: Array.isArray(body.evidenceRefs)
          ? body.evidenceRefs.map(String)
          : Array.isArray(body.evidence_refs)
            ? body.evidence_refs.map(String)
            : [],
      });
      return { status: "ok", ...result };
    } catch (error) {
      sendSeedError(reply, error);
    }
  });

  app.get("/api/v1/memory/seeds/:seedId/changes", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listSeedChangeHistory(
      scope,
      String((req.params as any).seedId),
      Number((req.query as any).limit || 100),
    );
  });

  app.post("/api/v1/memory/seeds/restore-defaults", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    return restoreDefaultSeeds(scope);
  });

  app.get("/api/v1/memory/seeds/:seedId/versions", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listSeedVersions(scope, String((req.params as any).seedId), Number((req.query as any).limit || 50));
  });

  app.get("/api/v1/memory/seed-versions", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listSeedVersions(scope, undefined, Number((req.query as any).limit || 100));
  });

  app.get("/api/v1/memory/facts", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listFacts(scope, (req.query as any).status);
  });

  app.get("/api/v1/memory/baseline", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return getBaseline(scope);
  });

  app.get("/api/v1/memory/affect-timeline", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const limit = Number((req.query as any).limit || 200);
    const granularity = String((req.query as any).granularity || "turn");
    if (!["turn", "day", "week", "month", "quarter", "year"].includes(granularity)) {
      reply.code(422).send({ detail: "invalid granularity" });
      return;
    }
    return getAffectTimeline(scope, limit, granularity);
  });

  app.get("/api/v1/memory/retrospect", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const granularity = String((req.query as any).granularity || "week");
    if (!["week", "month", "quarter", "year"].includes(granularity)) {
      reply.code(422).send({ detail: "invalid granularity" });
      return;
    }
    const bucketKey = (req.query as any).bucketKey as string | undefined;
    try {
      if (String((req.query as any).recompute || "").toLowerCase() === "true") {
        return await recomputeRetrospect(scope, granularity, bucketKey);
      }
      return getRetrospect(scope, granularity, bucketKey);
    } catch (error: any) {
      const code = String(error?.code || error?.message || "error");
      if (code === "invalid_bucket_key" || code === "invalid_granularity") {
        reply.code(422).send({ detail: code });
        return;
      }
      throw error;
    }
  });

  app.get("/api/v1/memory/retrospect/buckets", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const granularity = String((req.query as any).granularity || "week");
    if (!["week", "month", "quarter", "year"].includes(granularity)) {
      reply.code(422).send({ detail: "invalid granularity" });
      return;
    }
    return listRetrospectBuckets(scope, granularity);
  });

  app.get("/api/v1/memory/constraints", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listConstraints(scope);
  });

  app.delete("/api/v1/memory/constraints/:constraintId", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const deleted = deleteConstraint(scope, Number((req.params as any).constraintId));
    if (!deleted) {
      reply.code(404).send({ detail: "not_found" });
      return;
    }
    return { status: "ok" };
  });

  app.get("/api/v1/memory/appointments", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listAppointments(scope);
  });

  app.get("/api/v1/memory/self-state", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return getSelfState(scope);
  });

  app.get("/api/v1/memory/self-state/history", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return readSelfStateHistory(scope, Number((req.query as any).limit || 200));
  });

  app.get("/api/v1/memory/mirror", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return getMirror(scope);
  });

  // ─── Recall audit (observability) ──────────────────────────────────────────

  app.get("/api/v1/memory/recall/stream", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const sessionKey = recallSessionKey(scope.agentId, scope.userId);
    for (const item of listRecallEvents(sessionKey, 20)) {
      res.write(`event: recall\ndata: ${JSON.stringify(item)}\n\n`);
    }
    const unsubscribe = subscribeRecallEvents(sessionKey, (item: any) => {
      if (!res.writableEnded) res.write(`event: recall\ndata: ${JSON.stringify(item)}\n\n`);
    });
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 5000);
    res.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.get("/api/v1/memory/recall/events", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const limit = Number((req.query as any).limit || 50);
    const sessionKey = recallSessionKey(scope.agentId, scope.userId);
    const items = listRecallEvents(sessionKey, Number.isFinite(limit) ? limit : 50);
    return { items, total: items.length, sessionKey };
  });

  app.get("/api/v1/memory/recall/:turnId", async (req, reply) => {
    const turnId = Number((req.params as any).turnId);
    if (!Number.isInteger(turnId) || turnId <= 0) {
      reply.code(400).send({ detail: "invalid turnId" });
      return;
    }
    const trace = getRecallTrace(turnId);
    const agentId = Number((trace as any).agentId || 0);
    const userId = String((trace as any).userId || "default_user");
    const options = {
      agentId,
      userId,
      sessionKey: recallSessionKey(agentId, userId),
      turnId,
      timestamp: (trace as any).createdAt,
    };
    // Backward compatible: every legacy field stays untouched, the rendered
    // report is appended.
    return {
      ...trace,
      human_report: buildHumanReport(trace as any, options),
      json_record: buildJsonRecord(trace as any, options),
    };
  });

  app.get("/api/v1/memory/embedding-cache", async () => {
    return queryEmbeddingCacheStats();
  });

  app.get("/api/v1/memory/tick-log", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    const query = req.query as Record<string, any>;
    const since = query.since ? String(query.since) : undefined;
    const until = query.until ? String(query.until) : undefined;
    if (since && Number.isNaN(new Date(since).getTime())) {
      reply.code(400).send({ detail: "invalid since timestamp" });
      return;
    }
    if (until && Number.isNaN(new Date(until).getTime())) {
      reply.code(400).send({ detail: "invalid until timestamp" });
      return;
    }
    return listTickLog(scope, {
      tickTypes: arrayParam(query.tickType),
      outcomes: arrayParam(query.outcome),
      since,
      until,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  app.get("/api/v1/memory/tick-log/stream", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const initial = listTickLog(scope, { limit: 20 });
    for (const item of initial.items) {
      res.write(`event: tick\ndata: ${JSON.stringify(item)}\n\n`);
    }
    const unsubscribe = subscribeTickLog((item: any) => {
      if (Number(item.agentId) === scope.agentId && String(item.userId) === scope.userId) {
        res.write(`event: tick\ndata: ${JSON.stringify(item)}\n\n`);
      }
    });
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 5000);
    res.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.post("/api/v1/memory/tick-log/clear", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    return clearTickLog(scope);
  });

  app.get("/api/v1/memory/turns", async (req, reply) => {
    const query = req.query as Record<string, any>;
    const agentId = Number(query.agentId);
    const start = Number(query.start);
    const end = Number(query.end ?? query.start);
    if (!Number.isInteger(agentId) || agentId <= 0 || !Number.isInteger(start) || start < 1) {
      reply.code(400).send({ detail: "agentId and start are required" });
      return;
    }
    const result = listMemoryTurns(agentId, query.userId, start, end);
    return result.items.length ? result : { items: [], missing: true };
  });

  app.get("/api/v1/memory/turn/:turnId", async (req, reply) => {
    const query = req.query as Record<string, any>;
    const turnId = Number((req.params as any).turnId);
    if (!Number.isInteger(turnId) || turnId <= 0) {
      reply.code(400).send({ detail: "invalid turnId" });
      return;
    }
    let agentId = Number(query.agentId);
    let userId = query.userId as string | undefined;
    if (!Number.isInteger(agentId) || agentId <= 0) {
      const row = getDb()
        .prepare("SELECT agent_id, user_id, role FROM chat_messages WHERE id = ?")
        .get(turnId) as { agent_id: number; user_id: string; role: string } | undefined;
      if (!row || row.role !== "assistant") {
        reply.code(404).send({ detail: "Turn not found" });
        return;
      }
      agentId = Number(row.agent_id);
      userId = row.user_id;
    }
    const item = getMemoryTurn(agentId, userId, turnId);
    if (!item) {
      reply.code(404).send({ detail: "Turn not found" });
      return;
    }
    return item;
  });

  app.get("/api/v1/memory/graph", async (req, reply) => {
    const query = req.query as Record<string, any>;
    const agentId = Number(query.agentId || 0);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      // Python defaults agentId to 0, which matches no agent and therefore
      // renders an empty graph. Falling back to agent 1 would silently show
      // a different character's memories instead.
      reply.code(400).send({ detail: "agentId is required" });
      return;
    }
    const scope = memoryScope(agentId, query.userId);
    return memoryGraph(scope, Number(query.limit || 120));
  });

  app.post("/api/v1/memory/clear-all", async (req, reply) => {
    const scope = scopeFromBodyOrQuery(req, reply);
    if (!scope) return;
    return clearAllMemory(scope);
  });

  app.get("/api/v1/memory/stats", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return getStats(scope);
  });

  app.get("/api/v1/memory/threads", async (req, reply) => {
    const scope = scopeFromQuery(req, reply);
    if (!scope) return;
    return listMemoryThreads(scope);
  });
}
