import type OpenAI from "openai";
import {
  ToolContext,
  ToolResult,
  executeNativeTool,
  isNativeToolEnabled,
  listNativeToolDefinitions,
} from "./nativeTools.js";
import { callMcpTool, listAllMcpTools } from "../services/mcpService.js";
import { getSettings } from "../services/settingsService.js";
import { isToolApprovalRequired } from "./nativeTools.js";

export interface AvailableTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source: "native" | "mcp";
  serverName?: string;
  originalName?: string;
}

export interface ToolExecutionResult extends ToolResult {
  tool_name: string;
  source: "native" | "mcp";
  is_error: boolean;
}

export async function listAvailableTools(context?: ToolContext): Promise<AvailableTool[]> {
  const nativeTools = listNativeToolDefinitions(context)
    .filter((tool) => isNativeToolEnabled(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      source: "native" as const,
    }));
  const mcpTools = (await listAllMcpTools()).map((tool) => ({
    name: tool.fullName,
    description: tool.description,
    parameters: tool.inputSchema,
    source: "mcp" as const,
    serverName: tool.serverName,
    originalName: tool.originalName,
  }));
  return [...nativeTools, ...mcpTools];
}

export function toOpenAITools(tools: AvailableTool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const native = listNativeToolDefinitions(context).find((tool) => tool.name === name);
  if (native && isNativeToolEnabled(name)) {
    const result = await executeNativeTool(name, args, context);
    return {
      ...result,
      tool_name: name,
      source: "native",
      is_error: result.status === "error",
    };
  }
  const result = await callMcpTool(name, args);
  return {
    status: result.status,
    preview: result.preview,
    summary: { strategy: "inline", source: "mcp" },
    tool_name: name,
    source: "mcp",
    is_error: result.isError,
  };
}

export function requiresApproval(name: string, args: Record<string, unknown>): boolean {
  const settings = getSettings() as Record<string, any>;
  if (settings.fullAccessEnabled) return false;
  if (isNativeTool(name)) return isToolApprovalRequired(name, args);
  return true;
}

export function isNativeTool(name: string): boolean {
  return listNativeToolDefinitions().some((tool) => tool.name === name);
}
