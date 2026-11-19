import type { FastifyInstance } from "fastify";
import {
  getMijiaLoginState,
  mijiaEnabled,
  mijiaLogout,
  mijiaStatus,
  mijiaVerifyLogin,
  setMijiaEnabled,
  startMijiaLogin,
} from "../services/mijiaService.js";

export async function registerPluginRoutes(app: FastifyInstance) {
  app.get("/api/v1/plugins/mijia/status", async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const verify =
      String(query.verify || "") === "1" ? await mijiaVerifyLogin() : null;
    return { ...mijiaStatus(), enabled: mijiaEnabled(), verify };
  });

  app.post("/api/v1/plugins/mijia/login", async (_req, reply) => {
    try {
      return await startMijiaLogin();
    } catch (error) {
      reply.code(502).send({
        detail: error instanceof Error ? error.message : "获取米家登录二维码失败",
      });
    }
  });

  app.get("/api/v1/plugins/mijia/login/:loginId", async (req, reply) => {
    const loginId = String(
      (req.params as Record<string, unknown>).loginId || "",
    ).trim();
    if (!loginId) {
      reply.code(400).send({ detail: "loginId is required" });
      return;
    }
    return getMijiaLoginState(loginId);
  });

  app.post("/api/v1/plugins/mijia/logout", async () => {
    mijiaLogout();
    return { status: "success" };
  });

  app.put("/api/v1/plugins/mijia/enabled", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.enabled === undefined) {
      reply.code(400).send({ detail: "enabled is required" });
      return;
    }
    setMijiaEnabled(Boolean(body.enabled));
    return { enabled: mijiaEnabled(), status: "success" };
  });
}
