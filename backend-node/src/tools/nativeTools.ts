import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getSettings } from "../services/settingsService.js";
import { getSkill, listSkills, truncateSkillBody } from "../services/skillService.js";
import {
  activeSkillMetadata,
  bindSkillToThread,
  unbindSkillFromThread,
} from "../services/skillBindingService.js";
import { getAgent } from "../services/agentService.js";
import {
  bumpImageGenCooldown,
  readImageGenAvailability,
  recordSuccessfulImageGeneration,
  resolveImageGenConfig,
} from "../services/toolPolicy.js";
import { executeMijiaTool, isMijiaTool, mijiaStatus } from "../services/mijiaService.js";
import { mijiaToolDefinitions } from "./mijiaTools.js";
import {
  executeMemoryTool,
  isMemoryTool,
  MEMORY_TOOL_DEFINITIONS,
} from "./memoryTools.js";

export interface NativeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  callScoped?: boolean;
  /** Skill meta-tools stay available regardless of the native tool toggles. */
  alwaysEnabled?: boolean;
  /** Tools sharing one plugin-level toggle (currently only Mijia). */
  group?: string;
}

export interface ToolContext {
  sessionId?: number;
  turnId?: string;
  agentId?: number;
  userId?: string;
  workspacePath?: string;
  voiceCall?: boolean;
}

export interface ToolResult {
  status: "success" | "error" | "soft_reject";
  preview: string;
  summary: { strategy: "inline"; source: string };
  [key: string]: unknown;
}

const NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "get_weather",
    description: "查询指定城市当前天气。",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: ["string", "null"], description: "城市名称，留空为自动定位" },
        lang: { type: "string", description: "语言，默认 zh-cn" },
      },
    },
  },
  {
    name: "file_read_text",
    description: "读取工作区内的文本文件。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径" },
        max_chars: { type: "number", description: "最大读取字符数，默认 12000" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "file_write_text",
    description: "写入文本文件（会自动创建父目录）。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径" },
        text: { type: "string", description: "写入内容" },
      },
      required: ["file_path", "text"],
    },
  },
  {
    name: "run_terminal_command",
    description: "在工作区执行终端命令并返回输出。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        wait_for_output: { type: "boolean", description: "是否等待执行完成，默认 true" },
      },
      required: ["command"],
    },
  },
  {
    name: "generate_image",
    description:
      "根据提示词生成图片并返回图片地址。仅当用户本轮明确要求现在看图/自拍/照片/画画时才调用，不要主动发。" +
      "成功后系统会把照片作为图片消息单独推送到用户的聊天窗口，工具结果里会写明「照片已送达用户屏幕」并附上画面描述；" +
      "这时你要用角色口吻自然回应这件事，可以承认已经发给他（例如「给你了」「刚那张」「你看那张」），可以顺带提一句画面内容，" +
      "禁止说生成/生图/AI/工具/系统/冷却/配额，禁止贴 URL 或 markdown 图片语法，也不要说「没发出来」「我这边看不到」。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "生图提示词，由你根据用户请求与对话上下文撰写（中文优先，约 80～300 字）。" +
            "有参考图时（use_agent_avatar=true）必须倾向第一人称自拍视角（如「手持手机前置镜头自拍」「半身自拍照」），" +
            "严禁使用「一个女孩/一位年轻女性/她」等泛化第三人称主语，只写动作、服装、姿势、场景与光线，严禁复述或形容五官长相；" +
            "无参考图时（use_agent_avatar=false，纯风景/物品/无关第三方/概念画作）视角与人称随意。",
        },
        use_agent_avatar: {
          type: "boolean",
          description:
            "是否尝试用当前智能体头像作为参考图。自拍、生活照、形象照、「你的照片」等涉及本人形象时为 true；" +
            "仅当用户明确要无关第三方/风景/物品且与智能体形象无关时才为 false。" +
            "（若当前生图服务商不支持参考图，系统会自动转为纯文生图）。",
        },
        aspect_ratio: { type: "string", description: "宽高比，例如 3:4" },
        size: { type: ["string", "null"], description: "图片尺寸，例如 1024x1024" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "end_voice_call",
    description: "结束当前语音通话，并说一句告别语。",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        farewell: { type: "string", description: "告别语，1-80 字" },
      },
      required: ["farewell"],
    },
    callScoped: true,
  },
  {
    name: "skills_list",
    description:
      "列出本机已安装的技能（SKILL.md）。当现有工具不足以完成任务时，先调用此工具查看可用技能。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "可选关键词，用于按名称或描述过滤" },
      },
    },
    alwaysEnabled: true,
  },
  {
    name: "skills_activate",
    description:
      "激活指定技能到当前会话。激活后会加载该技能正文，并在后续回合持续生效。name 必须来自 skills_list 的返回值。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名称" },
      },
      required: ["name"],
    },
    alwaysEnabled: true,
  },
  {
    name: "skills_deactivate",
    description: "停用当前会话中已激活的技能。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名称" },
      },
      required: ["name"],
    },
    alwaysEnabled: true,
  },
  {
    name: "skills_active",
    description: "列出当前会话已激活的技能。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    alwaysEnabled: true,
  },
  ...mijiaToolDefinitions,
  // M3 memory tools (save_memory / search_memory / manage_alarm): base
  // abilities in the APP, no toggle — always bound for private chat / calls.
  ...MEMORY_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    alwaysEnabled: true as const,
  })),
];

export function listNativeToolDefinitions(context?: ToolContext): NativeToolDefinition[] {
  return NATIVE_TOOLS.filter((tool) => !tool.callScoped || context?.voiceCall);
}

export function isNativeToolEnabled(name: string): boolean {
  const definition = NATIVE_TOOLS.find((tool) => tool.name === name);
  if (definition?.alwaysEnabled) return true;
  const settings = getSettings() as Record<string, any>;
  const enabledMap = settings.nativeToolEnabled || {};
  if (definition?.group === "mijia") {
    return Boolean(enabledMap.mijia) && mijiaStatus().authenticated;
  }
  return Boolean(enabledMap[name]);
}

export function nativeToolEnabledMap(): Record<string, boolean> {
  const settings = getSettings() as Record<string, any>;
  const enabledMap = settings.nativeToolEnabled || {};
  return Object.fromEntries(
    NATIVE_TOOLS.map((tool) => {
      if (!tool.alwaysEnabled && tool.group === "mijia") {
        return [tool.name, Boolean(enabledMap.mijia)];
      }
      return [tool.name, tool.alwaysEnabled ? true : Boolean(enabledMap[tool.name])];
    }),
  );
}

/**
 * Python `core/services/tool_execution_service.py::_check_approval_required`
 * sensitive-tool table: the file writing / shell / script tools plus every
 * `mcp_`-prefixed tool.
 *
 * `generate_image` is deliberately NOT part of it — it is a content tool and
 * asking the user to approve every photo made the feature unusable.
 */
const APPROVAL_REQUIRED_TOOLS = new Set([
  "file_write_text",
  "file.write_text",
  "run_shell_command",
  "run_terminal_command",
  "delete_file",
  "execute_script",
]);

export function isToolApprovalRequired(name: string, args: Record<string, unknown>): boolean {
  const settings = getSettings() as Record<string, any>;
  if (settings.fullAccessEnabled) return false;
  if (name === "run_terminal_command") {
    const command = String(args.command || "").trim();
    const first = command.split(/\s+/)[0] || "";
    const trusted = Array.isArray(settings.trustedCommands) ? settings.trustedCommands : [];
    if (first && trusted.includes(first)) return false;
  }
  return APPROVAL_REQUIRED_TOOLS.has(name) || name.startsWith("mcp_");
}

function workspaceOf(context: ToolContext): string {
  return path.resolve(context.workspacePath || process.cwd());
}

function assertInsideRoots(target: string, roots: unknown, workspace: string, mode: "read" | "write") {
  const list = Array.isArray(roots) && roots.length ? roots : ["."];
  const resolvedTarget = path.resolve(target);
  const allowed = list.some((root) => {
    const resolvedRoot = path.resolve(workspace, String(root));
    const relative = path.relative(resolvedRoot, resolvedTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw Object.assign(new Error(`路径不在允许的${mode === "read" ? "读取" : "写入"}范围内`), {
      errorClass: "permission_error",
    });
  }
}

function resolveWorkspacePath(raw: string, context: ToolContext): string {
  const workspace = workspaceOf(context);
  const target = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
  return target;
}

function success(preview: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    status: "success",
    preview,
    summary: { strategy: "inline", source: "native" },
    ...extra,
  };
}

function failure(message: string, errorClass = "failure", extra: Record<string, unknown> = {}): ToolResult {
  return {
    status: "error",
    preview: message,
    error_class: errorClass,
    summary: { strategy: "inline", source: "native" },
    ...extra,
  };
}

function sanitizeTerminalOutput(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function runCommand(command: string, context: ToolContext): Promise<ToolResult> {
  const workspace = workspaceOf(context);
  const started = Date.now();
  return await new Promise<ToolResult>((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(
        failure(`命令执行超时（120s）`, "timeout_error", {
          command,
          stdout: sanitizeTerminalOutput(stdout).slice(0, 20000),
          stderr: sanitizeTerminalOutput(stderr).slice(0, 4000),
          exit_code: null,
        }),
      );
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 200_000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 50_000) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure(error.message, "environment_error", { command }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanOut = sanitizeTerminalOutput(stdout).slice(0, 20000);
      const cleanErr = sanitizeTerminalOutput(stderr).slice(0, 4000);
      const preview = cleanOut || cleanErr || "__COMMAND_EXECUTED_NO_TEXT_OUTPUT__";
      resolve(
        success(preview, {
          command,
          stdout: cleanOut,
          stderr: cleanErr,
          exit_code: code,
          duration_ms: Date.now() - started,
        }),
      );
    });
  });
}

const IDENTITY_LOCK_SUFFIX =
  "以第一人称视角呈现，保持参考图人物的五官、脸型、神态与身份完全一致，" +
  "不要改变面部特征、表情气质与人物辨识度，" +
  "仅可调整服装、姿势、场景、光线与构图。";

/**
 * Python `compose_seedream_prompt`: keep the prompt first-person and lock the
 * identity when an actual reference image is used.
 */
export function composeSeedreamPrompt(prompt: string, hasReference: boolean): string {
  const base = String(prompt || "").trim();
  if (!base || !hasReference) return base;
  const cleanBase = base.replace(/[。，,.!！\s]+$/, "");
  const withPerspective = /^(第一人称|自拍|前置镜头|手持手机)/.test(cleanBase)
    ? cleanBase
    : `第一人称视角，${cleanBase}`;
  if (withPerspective.includes(IDENTITY_LOCK_SUFFIX)) return withPerspective;
  return `${withPerspective}。${IDENTITY_LOCK_SUFFIX}`;
}

function isVolcengineSource(config: ReturnType<typeof resolveImageGenConfig>): boolean {
  const source = config.source;
  const baseUrl = config.baseUrl.toLowerCase();
  const model = config.model.toLowerCase();
  return source === "volcengine" || baseUrl.includes("volces.com") || model.includes("seedream");
}

function isSensenovaSource(config: ReturnType<typeof resolveImageGenConfig>): boolean {
  const source = config.source;
  const baseUrl = config.baseUrl.toLowerCase();
  const model = config.model.toLowerCase();
  return source === "sensenova" || baseUrl.includes("sensenova") || model.includes("sensenova");
}

function isSeedreamProModel(model: string): boolean {
  const value = String(model || "").trim().toLowerCase();
  if (!value.includes("seedream")) return false;
  return /(^|[-_/])pro([-_/]|$)/.test(value);
}

/**
 * Providers that reject the `watermark` field outright. Mirrors app-local's
 * `imageGenClient.ts`, which drops it for Agnes and SiliconFlow only.
 */
function rejectsWatermarkParam(config: ReturnType<typeof resolveImageGenConfig>): boolean {
  const baseUrl = config.baseUrl.toLowerCase();
  return baseUrl.includes("siliconflow") || baseUrl.includes("agnes-ai");
}

/**
 * Python `image_generation_service.supports_reference_image`: only Volcengine
 * Seedream and SenseNova accept a reference image.
 */
export function supportsReferenceImage(config: ReturnType<typeof resolveImageGenConfig>): boolean {
  return isVolcengineSource(config) || isSensenovaSource(config);
}

/**
 * Python `image_generation_service.resolve_agent_avatar_data_uri`.
 *
 * The Node backend can forward a data URI or an absolute URL as-is. A GUI
 * relative path (`/lingshu.png`) is resolved against the packaged GUI asset
 * folders and inlined as a data URI; when nothing can be resolved the avatar
 * is simply skipped (no fake reference image is invented).
 */
export async function resolveAgentAvatarReference(agentId?: number | null): Promise<string | null> {
  if (!agentId) return null;
  let avatar: string | null = null;
  try {
    avatar = getAgent(agentId)?.avatar ?? null;
  } catch {
    avatar = null;
  }
  const value = String(avatar || "").trim();
  if (!value) return null;
  if (value.toLowerCase().startsWith("data:")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith("/")) return null;
  return await readLocalAvatarAsDataUri(value);
}

async function readLocalAvatarAsDataUri(relative: string): Promise<string | null> {
  const clean = relative.split("?")[0].replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  const roots = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
    path.resolve(process.cwd(), "..", "..", ".."),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const sub of ["public", "dist", ""]) {
      candidates.push(path.resolve(root, sub, clean));
    }
  }
  for (const candidate of candidates) {
    try {
      const bytes = await fs.readFile(candidate);
      const ext = path.extname(candidate).toLowerCase();
      const mime =
        ext === ".webp"
          ? "image/webp"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "image/png";
      return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function generateImage(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const config = resolveImageGenConfig();
  if (!config.configured) {
    return failure("图片生成服务未配置", "tool_unavailable");
  }
  const size = String(args.size || "") || undefined;
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return failure("prompt 不能为空", "arg_error");

  const availability = readImageGenAvailability();
  if (availability.dailyRemaining !== null && availability.dailyRemaining <= 0) {
    return failure(
      `今日图像生成次数已用尽（上限 ${config.dailyLimit} 次），现在发不出新图。` +
        "请在角色口吻里推到改天，别提次数、配额、生成、工具或系统。",
      "daily_quota_exhausted",
    );
  }
  if (availability.cooldownRemainingS > 0) {
    // Python restarts the wait clock when the model calls through a cooldown.
    const wait = bumpImageGenCooldown();
    return failure(
      `刚才已经发过一张，间隔（约 ${wait} 秒）还没到，现在发不出新图。` +
        "请在角色口吻里推脱或改口（例如说改天再画、现在不方便），别提生成、工具、冷却或配额。",
      "cooldown_active",
    );
  }

  const useAgentAvatar = args.use_agent_avatar === undefined ? true : Boolean(args.use_agent_avatar);
  let reference: string | null = null;
  if (useAgentAvatar && supportsReferenceImage(config)) {
    reference = await resolveAgentAvatarReference(context.agentId);
  }
  const finalPrompt = composeSeedreamPrompt(prompt, Boolean(reference));

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      prompt: finalPrompt,
      size,
      response_format: "url",
      // Watermark has to be turned off explicitly: the image endpoints we use
      // watermark by default. Both reference implementations send it the same
      // way (Python `core/services/image_generation_service.py`, app-local
      // `src/tools/imageGenClient.ts`); providers that reject unknown
      // parameters drop it again below.
      watermark: false,
    };
    if (isVolcengineSource(config)) {
      if (!isSeedreamProModel(config.model)) body.sequential_image_generation = "disabled";
      if (reference) body.image = reference;
    } else if (isSensenovaSource(config)) {
      body.prompt_extend = true;
      if (reference) body.images = [{ image_url: reference }];
    }
    if (rejectsWatermarkParam(config)) delete body.watermark;
    const endpoint = `${config.baseUrl}/images/generations`;
    // The outbound payload is kept (key redacted) so the drawer's call log can
    // show exactly what was sent to the image provider.
    const providerRequest = {
      url: endpoint,
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ***" },
      body,
    };
    let providerResponse: Record<string, unknown> = {};
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerResponse = { error: message };
      return failure(message, "environment_error", {
        provider: config.source,
        provider_request: providerRequest,
        provider_response: providerResponse,
      });
    }
    const data: any = await res.json().catch(() => ({}));
    providerResponse = {
      status: res.status,
      ok: res.ok,
      model: data?.model ?? null,
      created: data?.created ?? null,
      data: Array.isArray(data?.data)
        ? data.data.map((item: any) => ({
            url: item?.url ?? null,
            revised_prompt: item?.revised_prompt ?? null,
            b64_json: item?.b64_json ? `[base64, ${String(item.b64_json).length} 字符]` : null,
          }))
        : null,
      error: data?.error ?? null,
    };
    if (!res.ok) {
      return failure(String(data?.error?.message || data?.message || `图片生成失败 (${res.status})`), "provider_error", {
        provider: config.source,
        provider_request: providerRequest,
        provider_response: providerResponse,
      });
    }
    const images = (data.data || []).map((item: any) => ({
      url: item.url,
      b64_json: item.b64_json,
      revised_prompt: item.revised_prompt,
    }));
    if (!images.length) {
      return failure("图片生成返回为空", "provider_error", {
        provider: config.source,
        provider_request: providerRequest,
        provider_response: providerResponse,
      });
    }
    const quota = recordSuccessfulImageGeneration();
    return success(`已生成 ${images.length} 张图片`, {
      images,
      usedAgentAvatar: Boolean(reference),
      quota: { dailyLimit: quota.dailyLimit, remaining: quota.remaining },
      provider: config.source,
      provider_request: providerRequest,
      provider_response: providerResponse,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), "environment_error");
  }
}

export async function executeNativeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const settings = getSettings() as Record<string, any>;
  const workspace = workspaceOf(context);
  try {
    if (isMijiaTool(name)) {
      const raw = await executeMijiaTool(name, args);
      let ok = true;
      try {
        const parsed = JSON.parse(raw) as { success?: boolean };
        ok = parsed?.success !== false;
      } catch {
        // Keep the raw payload for the model when the shape is unexpected.
      }
      return ok ? success(raw, { tool: name }) : failure(raw, "tool_error");
    }
    if (isMemoryTool(name)) {
      return await executeMemoryTool(name, args, context);
    }
    switch (name) {
      case "get_weather": {
        const city = String(args.city || "").trim();
        const lang = String(args.lang || "zh-cn");
        const url = `https://wttr.in/${encodeURIComponent(city || "")}?format=%l:+天气状况:+%C,+温度:+%t,+风向风速:+%w&lang=${encodeURIComponent(lang)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return failure(`天气查询失败 (${res.status})`, "tool_unavailable");
        const text = (await res.text()).trim();
        return success(text || "未获取到天气信息");
      }
      case "file_read_text": {
        const rawPath = String(args.file_path || "").trim();
        if (!rawPath) return failure("file_path 不能为空", "arg_error");
        const target = resolveWorkspacePath(rawPath, context);
        assertInsideRoots(target, settings.toolReadRoots, workspace, "read");
        const maxChars = Math.max(200, Number(args.max_chars) || 12000);
        const content = await fs.readFile(target, "utf-8");
        const truncated = content.length > maxChars;
        const preview = truncated ? `${content.slice(0, maxChars)}\n...[truncated]` : content;
        return success(preview, { file_path: target, length: content.length, truncated });
      }
      case "file_write_text": {
        const rawPath = String(args.file_path || "").trim();
        if (!rawPath) return failure("file_path 不能为空", "arg_error");
        const target = resolveWorkspacePath(rawPath, context);
        assertInsideRoots(target, settings.toolWriteRoots, workspace, "write");
        const text = String(args.text ?? "");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, text, "utf-8");
        return success(`已写入 ${text.length} 字符`, { file_path: target, length: text.length });
      }
      case "run_terminal_command": {
        const command = String(args.command || "").trim();
        if (!command) return failure("command 不能为空", "arg_error");
        if (args.wait_for_output === false) {
          spawn("/bin/zsh", ["-lc", command], {
            cwd: workspace,
            env: process.env,
            detached: true,
            stdio: "ignore",
          }).unref();
          return success("命令已在后台启动", { command, waited: false });
        }
        return await runCommand(command, context);
      }
      case "generate_image":
        return await generateImage(args, context);
      case "end_voice_call": {
        const farewell = String(args.farewell || "").trim();
        if (!farewell || farewell.length > 80) {
          return failure("farewell 需为 1-80 字", "arg_error");
        }
        return success(farewell, { terminal: true, final_text: farewell });
      }
      case "skills_list": {
        const query = String(args.query || "").trim().toLowerCase();
        const skills = listSkills().filter((skill) => {
          if (!query) return true;
          return (
            skill.name.toLowerCase().includes(query) ||
            skill.description.toLowerCase().includes(query)
          );
        });
        if (!skills.length) {
          return success(
            "当前没有已安装的技能。可以把技能放到 ~/.lingshu/skills/<name>/SKILL.md。",
            { skills: [] },
          );
        }
        return success(
          skills
            .map((skill) => `- ${skill.name}: ${skill.description || "（无描述）"}`)
            .join("\n"),
          {
            skills: skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              version: skill.version,
            })),
          },
        );
      }
      case "skills_activate": {
        const skillName = String(args.name || "").trim();
        if (!skillName) return failure("name 不能为空", "arg_error");
        if (!context.sessionId) {
          return failure("当前会话不支持技能绑定", "environment_error");
        }
        const bound = bindSkillToThread(context.sessionId, skillName, "tool");
        if (!bound.ok) return failure(bound.message, "tool_unavailable");
        const skill = getSkill(skillName);
        const body = skill ? truncateSkillBody(skill.body) : "";
        return success(`技能「${skillName}」已激活，后续回合会持续生效。`, {
          skill_name: skillName,
          skill_state: "bound",
          skill_body: body,
          skill_body_chars: skill?.bodyChars ?? body.length,
          active_skills: bound.activeSkills,
          loaded_skills: bound.loadedSkills,
        });
      }
      case "skills_deactivate": {
        const skillName = String(args.name || "").trim();
        if (!skillName) return failure("name 不能为空", "arg_error");
        if (!context.sessionId) {
          return failure("当前会话不支持技能绑定", "environment_error");
        }
        const result = unbindSkillFromThread(context.sessionId, skillName);
        if (!result.ok) return failure(result.message, "arg_error");
        return success(result.message, {
          skill_name: skillName,
          active_skills: result.activeSkills,
          loaded_skills: result.loadedSkills,
        });
      }
      case "skills_active": {
        if (!context.sessionId) {
          return failure("当前会话不支持技能绑定", "environment_error");
        }
        const meta = activeSkillMetadata(context.sessionId);
        if (!meta.active_skills.length) {
          return success("当前会话没有激活的技能。", meta);
        }
        return success(meta.active_skills.map((item) => `- ${item}`).join("\n"), meta);
      }
      default:
        return failure(`未知原生工具: ${name}`, "tool_unavailable");
    }
  } catch (error: any) {
    const errorClass = error?.errorClass || (error?.code === "ENOENT" ? "arg_error" : "failure");
    return failure(error instanceof Error ? error.message : String(error), errorClass);
  }
}
