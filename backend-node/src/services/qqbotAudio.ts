import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { wavHeader } from "./ttsService.js";

const execFileAsync = promisify(execFile);
const NATIVE_VOICE_EXTENSIONS = new Set(["mp3", "wav", "silk"]);
const SILK_SAMPLE_RATES = new Set([8000, 12000, 16000, 24000, 32000, 44100, 48000]);

function extensionOf(filename: string): string {
  return path.extname(String(filename || "")).replace(/^\./, "").toLowerCase();
}

function stemOf(filename: string, fallback = "qqbot-voice"): string {
  return path.basename(String(filename || ""), path.extname(String(filename || ""))) || fallback;
}

function sniffAudioFormat(data: Buffer): string | null {
  if (data.length < 4) return null;
  if (data.subarray(0, 4).toString("ascii") === "RIFF") return "wav";
  if (data.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return "mp3";
  if (data.subarray(0, 10).toString("ascii").includes("SILK")) return "silk";
  return null;
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate, 1, 16), pcm]);
}

async function encodeSilk(pcm: Buffer, sampleRate: number): Promise<Buffer | null> {
  try {
    const { encode } = await import("silk-wasm");
    const result = await encode(pcm, sampleRate);
    return Buffer.from(result.data);
  } catch {
    return null;
  }
}

export async function decodeSilkToWav(data: Buffer, sampleRate = 24000): Promise<Buffer | null> {
  try {
    const silk = data.subarray(0, 7).toString("ascii") === "#!AMR\n" ? data.subarray(7) : data;
    const { decode } = await import("silk-wasm");
    const result = await decode(silk, sampleRate);
    return pcmToWav(Buffer.from(result.data), sampleRate);
  } catch {
    return null;
  }
}

async function runFfmpeg(
  data: Buffer,
  inputExtension: string,
  outputName: string,
  args: string[],
): Promise<Buffer | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-qq-audio-"));
  const input = path.join(dir, `input.${inputExtension || "bin"}`);
  const output = path.join(dir, outputName);
  try {
    fs.writeFileSync(input, data);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-i", input, ...args, output],
      { timeout: 30_000 },
    );
    return fs.existsSync(output) ? fs.readFileSync(output) : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function transcodeToMp3(data: Buffer, inputExtension: string): Promise<Buffer | null> {
  return runFfmpeg(data, inputExtension, "output.mp3", [
    "-ac",
    "1",
    "-ar",
    "24000",
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "4",
  ]);
}

async function transcodeToWav(data: Buffer, inputExtension: string): Promise<Buffer | null> {
  return runFfmpeg(data, inputExtension, "output.wav", ["-ac", "1", "-ar", "16000", "-f", "wav"]);
}

export interface PreparedVoice {
  data: Buffer;
  filename: string;
  format: string;
}

export async function prepareOutboundVoice(
  data: Buffer,
  filename: string,
  format: string,
  sampleRate = 24000,
): Promise<PreparedVoice | null> {
  if (!data.length) return null;
  const sniffed = sniffAudioFormat(data);
  const declared = String(format || extensionOf(filename) || "").trim().toLowerCase();
  const effective = sniffed || (declared === "mpeg" ? "mp3" : declared);
  const stem = stemOf(filename);

  if (NATIVE_VOICE_EXTENSIONS.has(effective)) {
    return { data, filename: `${stem}.${effective}`, format: effective };
  }

  if (effective === "pcm" || (!sniffed && !declared)) {
    if (SILK_SAMPLE_RATES.has(sampleRate)) {
      const silk = await encodeSilk(data, sampleRate);
      if (silk) return { data: silk, filename: `${stem}.silk`, format: "silk" };
    }
    return { data: pcmToWav(data, sampleRate), filename: `${stem}.wav`, format: "wav" };
  }

  const mp3 = await transcodeToMp3(data, effective || extensionOf(filename) || "bin");
  if (mp3) return { data: mp3, filename: `${stem}.mp3`, format: "mp3" };
  return null;
}

export async function audioBytesToWav(data: Buffer, filename = "voice.amr"): Promise<Buffer | null> {
  if (!data.length) return null;
  const sniffed = sniffAudioFormat(data);
  if (sniffed === "wav") return data;
  if (sniffed === "silk" || ["silk", "slk", "slac"].includes(extensionOf(filename))) {
    const wav = await decodeSilkToWav(data);
    if (wav) return wav;
  }
  return transcodeToWav(data, extensionOf(filename) || "bin");
}
