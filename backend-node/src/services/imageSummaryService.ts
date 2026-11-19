import fs from "node:fs";
import path from "node:path";
import { getChatUploadDir } from "../runtimePaths.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";

export const IMAGE_SUMMARY_PLACEHOLDER = "用户发送了一张图片。";
/** Placeholder used for a picture the agent itself produced and sent. */
export const GENERATED_IMAGE_SUMMARY_PLACEHOLDER = "（智能体刚发出的一张照片）";

export function imageSummaryPath(uploadName: string): string {
  return path.join(getChatUploadDir(), `${path.basename(uploadName)}.summary.txt`);
}

export function readStoredImageSummary(uploadName: string): string | null {
  try {
    const text = fs.readFileSync(imageSummaryPath(uploadName), "utf-8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export function writeStoredImageSummary(uploadName: string, summary: string) {
  fs.writeFileSync(imageSummaryPath(uploadName), summary.trim(), "utf-8");
}

const USER_IMAGE_PROMPT =
  "请用中文详细描述这张图片的内容、场景、文字和值得记住的细节，供后续对话作为记忆使用。只输出描述。";

const GENERATED_IMAGE_PROMPT =
  "请用中文用一句话（不超过 60 字）描述这张图片的画面内容：主体、场景、光线、颜色。" +
  "用于让智能体确认自己刚发出的照片长什么样，不要评价质量，不要提到模型或工具，只输出这一句话。";

export interface SummarizeImageInput {
  uploadName: string;
  mimeType: string;
  data: Buffer;
  /** "user" for an uploaded picture, "generated" for one the agent produced. */
  kind?: "user" | "generated";
}

/**
 * Describe an image with the configured vision model.
 *
 * The summary is cached next to the upload file, so the same picture is only
 * described once — the agent re-reads it from disk on every later turn.
 * Failures are never fatal: the caller falls back to a placeholder.
 */
export async function summarizeImage(input: {
  uploadName: string;
  mimeType: string;
  data: Buffer;
}): Promise<string | null> {
  return summarizeImageBytes(input, "user");
}

export async function summarizeImageBytes(
  input: SummarizeImageInput,
  kind: "user" | "generated" = "user",
): Promise<string | null> {
  const cached = readStoredImageSummary(input.uploadName);
  if (cached) return cached;
  const visionConfig = getLLMConfig("vision");
  const cfg = visionConfig.model ? visionConfig : getLLMConfig("chat");
  if (!cfg.model || !cfg.baseUrl) return null;
  const dataUrl = `data:${input.mimeType};base64,${input.data.toString("base64")}`;
  try {
    const client = createOpenAIClient(cfg);
    const response = await createCompletionWithThinkingFallback(
      client,
      {
        model: cfg.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: kind === "generated" ? GENERATED_IMAGE_PROMPT : USER_IMAGE_PROMPT,
              },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ] as any,
        temperature: 0.2,
        ...buildThinkingParams(cfg),
      },
      cfg,
    );
    const summary = (response.choices?.[0]?.message?.content || "").trim();
    if (!summary) return null;
    writeStoredImageSummary(input.uploadName, summary);
    return summary;
  } catch {
    return null;
  }
}

/**
 * Describe a picture the agent just generated. The bytes are read back from
 * the chat upload folder (the provider payload itself may be a remote URL).
 */
export async function summarizeGeneratedImage(
  uploadName: string,
  mimeType: string,
): Promise<string | null> {
  const cached = readStoredImageSummary(uploadName);
  if (cached) return cached;
  try {
    const filePath = path.join(getChatUploadDir(), path.basename(uploadName));
    const data = fs.readFileSync(filePath);
    if (!data.length) return null;
    return await summarizeImageBytes(
      { uploadName, mimeType: mimeType || "image/png", data },
      "generated",
    );
  } catch {
    return null;
  }
}
