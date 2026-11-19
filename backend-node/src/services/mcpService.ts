import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "../db/sqlite.js";

export type McpTransportType = "stdio" | "sse" | "streamableHttp";

export interface McpServerRow {
  id: number;
  name: string;
  transport_type: string;
  command: string | null;
  args_json: string | null;
  env_json: string | null;
  url: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface McpServerInput {
  name: string;
  transport_type?: string;
  transportType?: string;
  command?: string | null;
  args?: string[] | string | null;
  env?: Record<string, string> | null;
  url?: string | null;
  is_active?: boolean;
  disabled?: boolean;
}

interface ConnectedServer {
  client: Client;
  serverName: string;
  tools: McpToolInfo[];
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fullName: string;
  serverName: string;
  originalName: string;
}

const registry = new Map<number, ConnectedServer>();

export function normalizeMcpTransport(raw: string | undefined | null): string {
  const value = String(raw || "").trim();
  const lower = value.toLowerCase().replace(/[-_\s]/g, "");
  if (lower === "streamablehttp" || lower === "http") return "streamableHttp";
  if (lower === "stdio" || lower === "studio" || lower === "stuidio") return "stdio";
  if (lower === "sse") return "sse";
  return value ? value.toLowerCase() : "stdio";
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function serializeArgs(input: McpServerInput): string[] {
  if (Array.isArray(input.args)) return input.args.map(String);
  if (typeof input.args === "string" && input.args.trim()) {
    try {
      const parsed = JSON.parse(input.args);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function serializeEnv(input: McpServerInput): Record<string, string> {
  if (!input.env || typeof input.env !== "object") return {};
  return Object.fromEntries(
    Object.entries(input.env)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

export function ensureDefaultMcpServer() {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) AS c FROM mcp_server_configs").get() as { c: number };
  if (count.c > 0) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_server_configs
      (name, transport_type, command, args_json, env_json, url, is_active, created_at, updated_at)
     VALUES ('exa', 'streamableHttp', NULL, NULL, NULL, 'https://mcp.exa.ai/mcp', 0, ?, ?)`,
  ).run(now, now);
}

export function toMcpServerResponse(row: McpServerRow) {
  const connected = registry.get(row.id);
  return {
    id: row.id,
    name: row.name,
    transport_type: row.transport_type,
    command: row.command,
    args: parseJson<string[] | null>(row.args_json, null),
    env: parseJson<Record<string, string> | null>(row.env_json, null),
    url: row.url,
    is_active: Boolean(row.is_active),
    connected: Boolean(connected),
    tool_count: connected?.tools.length ?? 0,
  };
}

export function listMcpServers(): McpServerRow[] {
  ensureDefaultMcpServer();
  return getDb()
    .prepare("SELECT * FROM mcp_server_configs ORDER BY id ASC")
    .all() as McpServerRow[];
}

export function getMcpServerById(id: number): McpServerRow | null {
  const row = getDb().prepare("SELECT * FROM mcp_server_configs WHERE id = ?").get(id) as
    | McpServerRow
    | undefined;
  return row ?? null;
}

export function getMcpServerByName(name: string): McpServerRow | null {
  const row = getDb().prepare("SELECT * FROM mcp_server_configs WHERE name = ?").get(name) as
    | McpServerRow
    | undefined;
  return row ?? null;
}

async function connectServer(row: McpServerRow): Promise<ConnectedServer> {
  const args = parseJson<string[]>(row.args_json, []);
  const env = parseJson<Record<string, string>>(row.env_json, {});
  const transportType = normalizeMcpTransport(row.transport_type);
  let client: Client;
  let transport: any;

  if (transportType === "stdio") {
    if (!row.command) throw new Error("stdio MCP server requires command");
    transport = new StdioClientTransport({
      command: row.command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "pipe",
    });
  } else {
    const targetUrl = row.url || row.command;
    if (!targetUrl) throw new Error(`${transportType} MCP server requires url`);
    if (transportType === "sse") {
      transport = new SSEClientTransport(new URL(targetUrl), {
        requestInit: { headers: env },
      });
    } else if (transportType === "streamableHttp") {
      transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
        requestInit: { headers: env },
      });
    } else {
      throw new Error(`unsupported transport: ${row.transport_type}`);
    }
  }

  client = new Client({ name: "lingshu-backend-node", version: "0.1.0" }, { capabilities: {} });
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP connect timeout")), 15_000)),
  ]);

  const listed = await client.listTools();
  const tools: McpToolInfo[] = (listed.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    inputSchema: (tool.inputSchema as Record<string, unknown>) || {
      type: "object",
      properties: {},
    },
    fullName: `${row.name}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_"),
    serverName: row.name,
    originalName: tool.name,
  }));
  return { client, serverName: row.name, tools };
}

export async function startMcpServer(row: McpServerRow): Promise<McpToolInfo[]> {
  await stopMcpServer(row.id);
  const connected = await connectServer(row);
  registry.set(row.id, connected);
  return connected.tools;
}

export async function stopMcpServer(serverId: number) {
  const connected = registry.get(serverId);
  if (!connected) return;
  registry.delete(serverId);
  try {
    await connected.client.close();
  } catch {
    // best effort
  }
}

export async function stopAllMcpServers() {
  for (const serverId of [...registry.keys()]) {
    await stopMcpServer(serverId);
  }
}

export async function startActiveMcpServers() {
  ensureDefaultMcpServer();
  const rows = getDb()
    .prepare("SELECT * FROM mcp_server_configs WHERE is_active = 1")
    .all() as McpServerRow[];
  for (const row of rows) {
    try {
      await startMcpServer(row);
    } catch {
      // individual server failures should not block backend startup
    }
  }
}

export async function createMcpServer(input: McpServerInput): Promise<
  { ok: true; row: McpServerRow } | { ok: false; statusCode: number; message: string }
> {
  const name = String(input.name || "").trim();
  if (!name) return { ok: false, statusCode: 400, message: "name is required" };
  if (getMcpServerByName(name)) {
    return { ok: false, statusCode: 400, message: "MCP server name already exists" };
  }
  const transport = normalizeMcpTransport(input.transport_type || input.transportType);
  if (!["stdio", "sse", "streamableHttp"].includes(transport)) {
    return { ok: false, statusCode: 400, message: `unsupported transport: ${transport}` };
  }
  const now = new Date().toISOString();
  const active = input.is_active === undefined ? input.disabled !== true : Boolean(input.is_active);
  const info = getDb()
    .prepare(
      `INSERT INTO mcp_server_configs
        (name, transport_type, command, args_json, env_json, url, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      transport,
      input.command || null,
      JSON.stringify(serializeArgs(input)),
      JSON.stringify(serializeEnv(input)),
      input.url || null,
      active ? 1 : 0,
      now,
      now,
    );
  const row = getMcpServerById(Number(info.lastInsertRowid))!;
  if (active) {
    try {
      await startMcpServer(row);
    } catch (error) {
      return {
        ok: false,
        statusCode: 503,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, row };
}

export async function updateMcpServer(
  id: number,
  input: McpServerInput,
): Promise<{ ok: true; row: McpServerRow } | { ok: false; statusCode: number; message: string }> {
  const existing = getMcpServerById(id);
  if (!existing) return { ok: false, statusCode: 404, message: "MCP server not found" };
  const transport = normalizeMcpTransport(input.transport_type || input.transportType || existing.transport_type);
  if (!["stdio", "sse", "streamableHttp"].includes(transport)) {
    return { ok: false, statusCode: 400, message: `unsupported transport: ${transport}` };
  }
  await stopMcpServer(id);
  const now = new Date().toISOString();
  const active = input.is_active === undefined ? existing.is_active === 1 : Boolean(input.is_active);
  getDb()
    .prepare(
      `UPDATE mcp_server_configs SET
        name = ?, transport_type = ?, command = ?, args_json = ?, env_json = ?, url = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      String(input.name || existing.name).trim() || existing.name,
      transport,
      input.command === undefined ? existing.command : input.command || null,
      JSON.stringify(input.args === undefined ? parseJson(existing.args_json, []) : serializeArgs(input)),
      JSON.stringify(input.env === undefined ? parseJson(existing.env_json, {}) : serializeEnv(input)),
      input.url === undefined ? existing.url : input.url || null,
      active ? 1 : 0,
      now,
      id,
    );
  const row = getMcpServerById(id)!;
  if (active) {
    try {
      await startMcpServer(row);
    } catch (error) {
      return {
        ok: false,
        statusCode: 503,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, row };
}

export async function deleteMcpServer(id: number): Promise<boolean> {
  const existing = getMcpServerById(id);
  if (!existing) return false;
  await stopMcpServer(id);
  getDb().prepare("DELETE FROM mcp_server_configs WHERE id = ?").run(id);
  return true;
}

export async function listMcpServerTools(serverName: string): Promise<McpToolInfo[]> {
  const row = getMcpServerByName(serverName);
  if (!row) return [];
  const connected = [...registry.entries()].find(([, value]) => value.serverName === serverName);
  if (connected) return connected[1].tools;
  try {
    return await startMcpServer(row);
  } catch {
    return [];
  }
}

export async function listAllMcpTools(): Promise<McpToolInfo[]> {
  const rows = getDb()
    .prepare("SELECT * FROM mcp_server_configs WHERE is_active = 1")
    .all() as McpServerRow[];
  const tools: McpToolInfo[] = [];
  for (const row of rows) {
    let connected = registry.get(row.id);
    if (!connected) {
      try {
        await startMcpServer(row);
        connected = registry.get(row.id);
      } catch {
        connected = undefined;
      }
    }
    if (connected) tools.push(...connected.tools);
  }
  return tools;
}

function contentToPreview(content: unknown): string {
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content;
    return JSON.stringify(content ?? "");
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, any>;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image") parts.push(`[image ${item.mimeType || "image"}]`);
    else if (item.type === "resource") {
      parts.push(item.resource?.text || item.resource?.uri || "[resource]");
    } else parts.push(JSON.stringify(item));
  }
  return parts.join("\n").trim();
}

export async function callMcpTool(
  fullName: string,
  args: Record<string, unknown>,
): Promise<{ status: "success" | "error"; preview: string; isError: boolean }> {
  const tools = await listAllMcpTools();
  const target = tools.find((tool) => tool.fullName === fullName);
  if (!target) return { status: "error", preview: `未知 MCP 工具: ${fullName}`, isError: true };
  const row = getMcpServerByName(target.serverName);
  if (!row) return { status: "error", preview: `MCP server 不存在: ${target.serverName}`, isError: true };
  const connected = registry.get(row.id);
  if (!connected) {
    return { status: "error", preview: `MCP server 未连接: ${target.serverName}`, isError: true };
  }
  try {
    const result = await connected.client.callTool({
      name: target.originalName,
      arguments: args,
    });
    const preview = contentToPreview((result as any).content);
    const isError = Boolean((result as any).isError);
    return { status: isError ? "error" : "success", preview, isError };
  } catch (error) {
    return {
      status: "error",
      preview: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

export async function importMcpServers(payload: { mcpServers?: Record<string, any> }) {
  const servers = payload?.mcpServers;
  if (!servers || typeof servers !== "object") return { status: "success", imported: 0 };
  let imported = 0;
  for (const [name, raw] of Object.entries(servers)) {
    if (getMcpServerByName(name)) continue;
    const config = (raw || {}) as Record<string, any>;
    const declared = String(config.type || config.transport_type || config.transportType || "");
    let transport = normalizeMcpTransport(declared);
    if (!declared) {
      transport = config.command ? "stdio" : "streamableHttp";
    }
    if (transport === "http") transport = "streamableHttp";
    const result = await createMcpServer({
      name,
      transport_type: transport,
      command: config.command || null,
      args: config.args || [],
      env: config.env || null,
      url: config.url || (transport !== "stdio" ? config.command || null : null),
      is_active: config.disabled === true ? false : true,
    });
    if (result.ok) imported += 1;
  }
  return { status: "success", imported };
}
