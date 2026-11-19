import type { FastifyInstance } from "fastify";
import {
  createMcpServer,
  deleteMcpServer,
  importMcpServers,
  listMcpServerTools,
  listMcpServers,
  toMcpServerResponse,
  updateMcpServer,
} from "../services/mcpService.js";
import {
  isNativeToolEnabled,
  listNativeToolDefinitions,
  nativeToolEnabledMap,
} from "../tools/nativeTools.js";
import { listAvailableTools } from "../tools/toolRegistry.js";
import { resolveToolApproval } from "../services/toolApprovalService.js";
import { getSecuritySettings, saveSecuritySettings } from "../services/settingsService.js";
import { getTaskRun, recordApprovalEvent } from "../services/taskService.js";

export async function registerToolsRoutes(app: FastifyInstance) {
  app.get("/api/v1/tools/mcp", async (_req, reply) => {
    return listMcpServers().map(toMcpServerResponse);
  });

  app.post("/api/v1/tools/mcp", async (req, reply) => {
    const result = await createMcpServer((req.body ?? {}) as any);
    if (!result.ok) {
      reply.code(result.statusCode).send({ detail: result.message });
      return;
    }
    return toMcpServerResponse(result.row);
  });

  app.put("/api/v1/tools/mcp/:serverId", async (req, reply) => {
    const id = Number((req.params as any).serverId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400).send({ detail: "invalid server id" });
      return;
    }
    const result = await updateMcpServer(id, (req.body ?? {}) as any);
    if (!result.ok) {
      reply.code(result.statusCode).send({ detail: result.message });
      return;
    }
    return toMcpServerResponse(result.row);
  });

  app.delete("/api/v1/tools/mcp/:serverId", async (req, reply) => {
    const id = Number((req.params as any).serverId);
    const deleted = await deleteMcpServer(id);
    if (!deleted) {
      reply.code(404).send({ detail: "MCP server not found" });
      return;
    }
    return { status: "success" };
  });

  app.get("/api/v1/tools/mcp/:serverName/tools", async (req, reply) => {
    const serverName = String((req.params as any).serverName || "");
    const tools = await listMcpServerTools(serverName);
    return tools.map((tool) => ({
      name: tool.fullName,
      description: tool.description,
      args_schema: tool.inputSchema,
    }));
  });

  app.get("/api/v1/tools/native", async () => {
    const enabledMap = nativeToolEnabledMap();
    return listNativeToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      args_schema: tool.inputSchema,
      enabled: Boolean(enabledMap[tool.name]),
      always_enabled: Boolean(tool.alwaysEnabled),
      group: tool.group || null,
      licensed: true,
      type: "native",
    }));
  });

  app.put("/api/v1/tools/native/:toolName", async (req, reply) => {
    const toolName = String((req.params as any).toolName || "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const definition = listNativeToolDefinitions().find((tool) => tool.name === toolName);
    if (!definition) {
      reply.code(404).send({ detail: "Unknown native tool" });
      return;
    }
    if (definition.alwaysEnabled) {
      reply.code(400).send({ detail: "This tool is always enabled" });
      return;
    }
    if (body.enabled === undefined) {
      reply.code(400).send({ detail: "enabled is required" });
      return;
    }
    const security = getSecuritySettings() as Record<string, any>;
    const nextMap = { ...(security.nativeToolEnabled || {}), [toolName]: Boolean(body.enabled) };
    saveSecuritySettings({ ...security, nativeToolEnabled: nextMap });
    return { name: toolName, enabled: isNativeToolEnabled(toolName), status: "success" };
  });

  app.post("/api/v1/tools/mcp/import", async (req, reply) => {
    return importMcpServers((req.body ?? {}) as any);
  });

  app.post("/api/v1/tools/approve", async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const callId = String(body.call_id || body.callId || "");
    const taskId = String(body.task_id || body.taskId || "").trim();
    const approved = Boolean(body.approved);
    const reason = body.reject_reason || body.rejectReason;
    const resolved = resolveToolApproval(callId, approved, reason);
    const task = taskId ? getTaskRun(taskId) : null;
    if (
      task &&
      callId &&
      ["running", "interrupted", "resumed"].includes(String(task.state || "").toLowerCase())
    ) {
      recordApprovalEvent(taskId, callId, approved, reason ? String(reason) : undefined);
    }
    return {
      status: "success",
      resolved,
      taskId: task ? taskId : null,
      taskState: task?.state ?? null,
      resumeRequired: task?.state === "interrupted",
    };
  });

  app.get("/api/v1/tools/list", async () => {
    const tools = await listAvailableTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      args_schema: tool.parameters,
      type: tool.source === "native" ? "native" : "dynamic",
      enabled: true,
    }));
  });
}
