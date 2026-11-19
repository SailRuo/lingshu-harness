import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listAgents,
  listSimpleAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  setDefaultAgent,
  getDefaultAgent,
  seedDefaultAgentIfEmpty,
} from "../services/agentService.js";

const CreateSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  avatar: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  roleSetting: z.string().nullable().optional(),
  speakingStyle: z.string().nullable().optional(),
  selfEvolutionEnabled: z.boolean().optional(),
  timeMirrorEnabled: z.boolean().optional(),
  proactiveEnabled: z.boolean().optional(),
});

const UpdateSchema = CreateSchema.partial();

export async function registerAgentRoutes(app: FastifyInstance) {
  seedDefaultAgentIfEmpty();

  app.get("/api/v1/agents", async () => listAgents());
  app.get("/api/v1/agents/simple", async () => listSimpleAgents());
  app.get("/api/v1/agents/defaults", async () => getDefaultAgent());

  app.post("/api/v1/agents", async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    try {
      return createAgent(parsed.data as any);
    } catch (e: any) {
      reply.code(400).send({ error: e?.message || "create_failed" });
    }
  });

  app.get("/api/v1/agents/:agent_id", async (req, reply) => {
    const id = Number((req.params as any).agent_id);
    const agent = getAgent(id);
    if (!agent) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    return agent;
  });

  app.put("/api/v1/agents/:agent_id", async (req, reply) => {
    const id = Number((req.params as any).agent_id);
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const agent = updateAgent(id, parsed.data as any);
    if (!agent) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    return agent;
  });

  app.delete("/api/v1/agents/:agent_id", async (req, reply) => {
    const id = Number((req.params as any).agent_id);
    const ok = deleteAgent(id);
    if (!ok) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    return { success: true };
  });

  app.post("/api/v1/agents/:agent_id/set-default", async (req, reply) => {
    const id = Number((req.params as any).agent_id);
    const agent = setDefaultAgent(id);
    if (!agent) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    return agent;
  });
}