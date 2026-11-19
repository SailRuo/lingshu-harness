import type { FastifyInstance } from "fastify";
import { getUsageStats, resetUsage } from "../services/usageService.js";

async function statsHandler(req: any) {
  const days = Number((req.query as any)?.days || 30);
  return getUsageStats(Math.max(1, Math.min(days, 180)));
}

async function resetHandler(req: any) {
  const body = (req.body ?? {}) as Record<string, any>;
  return resetUsage(body.clearToken !== false, body.clearTts !== false);
}

export async function registerUsageRoutes(app: FastifyInstance) {
  app.get("/api/v1/usage/stats", statsHandler);
  app.post("/api/v1/usage/reset", resetHandler);
  app.get("/api/usage/stats", statsHandler);
  app.post("/api/usage/reset", resetHandler);
}
