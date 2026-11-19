import type { FastifyInstance } from "fastify";
import { fetchProviderModelNames } from "../services/modelCatalogService.js";

export async function registerChatModelsRoutes(app: FastifyInstance) {
  app.get("/api/chat/models", async (req) => {
    const q = req.query as any;
    return fetchProviderModelNames({
      protocol: String(q.source || ""),
      baseUrl: String(q.baseUrl || ""),
      apiKey: q.apiKey ? String(q.apiKey) : undefined,
    });
  });
}
