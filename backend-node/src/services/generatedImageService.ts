import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getChatUploadDir } from "../runtimePaths.js";

/**
 * Port of the Python image delivery path:
 *
 *   core/services/image_generation_service.py::_save_generated_bytes
 *   core/orchestrator/runtime_chat_stream.py::_emit_image_event
 *
 * Python persists the freshly generated picture into `chat_uploads`, hands the
 * GUI a site-local URL (`/api/v1/chat/uploads/<name>`) and pushes a dedicated
 * `image` chat event. The Node backend used to keep the raw provider URL
 * inside the tool result only, so the GUI never rendered anything.
 *
 * This service owns the persistence side: it takes the raw tool-result image
 * (`b64_json` or `url`), writes it into the chat upload folder and returns the
 * payload shape the chat stream / DB expect.
 */

/** Same limit as the chat upload route (`routes/chatExtra.ts`). */
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

/** Python uses a 30s timeout for the image download. */
export const GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface GeneratedImagePayload {
  /** File name inside `chat_uploads` (also used as the DB / UI upload id). */
  uploadId: string;
  /** Site-local URL: the GUI resolves it against the backend base URL. */
  url: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  /** False when the remote image could not be persisted (remote URL kept). */
  persisted: boolean;
  /** Present when the provider reported the original file name. */
  revisedPrompt?: string;
}

/**
 * File suffix for a mime type. Shared with the chat upload route so a
 * generated picture and an uploaded picture are stored identically.
 */
export function guessSuffix(mimeType: string, fileName?: string): string {
  const fromName = path.extname(fileName || "").toLowerCase();
  if (fromName && /^\.[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heic",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
  };
  return map[mimeType] || ".bin";
}

/** Mime type for a stored file path. Shared with the chat upload route. */
export function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
  };
  return map[ext] || "application/octet-stream";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

/** Strip query / hash and keep the last path segment. */
function fileNameFromUrl(url: string): string {
  const clean = url.split("#")[0].split("?")[0];
  const base = path.basename(clean);
  return base || "";
}

function normalizeMime(raw: string | null | undefined): string {
  const value = String(raw || "").split(";")[0].trim().toLowerCase();
  return value;
}

/**
 * Decode a base64 payload. Accepts a bare base64 string as well as a
 * `data:<mime>;base64,...` URI (the provider may return either).
 */
function decodeBase64Payload(payload: string): { data: Buffer; mimeType: string | null } {
  let text = String(payload || "").trim();
  let mimeType: string | null = null;
  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    if (comma > 0) {
      const meta = normalizeMime(text.slice(5, comma).split(";")[0]);
      if (meta.startsWith("image/")) mimeType = meta;
      text = text.slice(comma + 1);
    }
  }
  try {
    return { data: Buffer.from(text, "base64"), mimeType };
  } catch {
    return { data: Buffer.alloc(0), mimeType };
  }
}

/** Detect the mime type from the magic bytes of the payload. */
function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }
  if (data.length >= 4) {
    const head = data.subarray(0, 4).toString("ascii");
    if (head === "II*\u0000" || head === "MM\u0000*") return "image/tiff";
  }
  return null;
}

async function writeUpload(data: Buffer, mimeType: string): Promise<GeneratedImagePayload> {
  const uploadName = `${randomUUID().replace(/-/g, "")}${guessSuffix(mimeType)}`;
  const target = path.join(getChatUploadDir(), uploadName);
  await fs.writeFile(target, data);
  return {
    uploadId: uploadName,
    url: `/api/v1/chat/uploads/${uploadName}`,
    mimeType,
    fileName: uploadName,
    sizeBytes: data.length,
    persisted: true,
  };
}

/**
 * Persist one image coming from a tool result.
 *
 * `b64_json` wins over `url` (no second request needed). When the remote
 * download fails the image is NOT dropped: the provider URL is returned as-is
 * and the payload is flagged as not persisted.
 */
export async function persistGeneratedImage(image: unknown): Promise<GeneratedImagePayload | null> {
  if (!image || typeof image !== "object") return null;
  const raw = image as Record<string, unknown>;
  const base64 = firstString(raw.b64_json, raw.b64Json, raw.base64, raw.image_base64);
  const remoteUrl = firstString(raw.url, raw.image_url, raw.imageUrl);
  const revisedPrompt = firstString(raw.revised_prompt, raw.revisedPrompt);

  const finalize = (payload: GeneratedImagePayload): GeneratedImagePayload =>
    revisedPrompt ? { ...payload, revisedPrompt } : payload;

  if (base64) {
    const decoded = decodeBase64Payload(base64);
    if (decoded.data.length) {
      const mimeType = decoded.mimeType || sniffImageMime(decoded.data) || "image/png";
      return finalize(await writeUpload(decoded.data, mimeType));
    }
  }

  if (!remoteUrl) return null;

  // Already a site-local upload: nothing to download, just reuse the file.
  if (remoteUrl.startsWith("/")) {
    const name = path.basename(remoteUrl.split("?")[0]);
    const filePath = path.join(getChatUploadDir(), name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return finalize({
          uploadId: name,
          url: `/api/v1/chat/uploads/${name}`,
          mimeType: guessMime(name),
          fileName: name,
          sizeBytes: stat.size,
          persisted: true,
        });
      }
    } catch {
      // not stored locally — fall through to the remote branch
    }
  }

  if (remoteUrl.startsWith("data:")) {
    const decoded = decodeBase64Payload(remoteUrl);
    if (decoded.data.length) {
      const mimeType = decoded.mimeType || sniffImageMime(decoded.data) || "image/png";
      return finalize(await writeUpload(decoded.data, mimeType));
    }
  }

  try {
    const response = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(GENERATED_IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) throw new Error("empty response body");
    if (data.length > MAX_CHAT_IMAGE_BYTES) throw new Error("image too large");
    const headerMime = normalizeMime(response.headers.get("content-type"));
    const mimeType =
      headerMime && headerMime.startsWith("image/")
        ? headerMime
        : sniffImageMime(data) || guessMime(fileNameFromUrl(remoteUrl));
    return finalize(await writeUpload(data, mimeType));
  } catch {
    // Keep the picture visible even when it could not be stored locally.
    const fileName = fileNameFromUrl(remoteUrl) || "generated-image";
    return finalize({
      uploadId: fileName,
      url: remoteUrl,
      mimeType: guessMime(fileName),
      fileName,
      sizeBytes: 0,
      persisted: false,
    });
  }
}

/**
 * Persist every image of a tool result. Entries that cannot be interpreted at
 * all are skipped; a failed download degrades to the remote URL.
 */
export async function persistGeneratedImages(images: unknown): Promise<GeneratedImagePayload[]> {
  if (!Array.isArray(images) || !images.length) return [];
  const payloads: GeneratedImagePayload[] = [];
  for (const item of images) {
    const payload = await persistGeneratedImage(item);
    if (payload) payloads.push(payload);
  }
  return payloads;
}
