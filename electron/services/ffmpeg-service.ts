import { randomUUID } from "node:crypto";
import { access, link, mkdir, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import type { MediaProbe } from "../../shared/models";
import { BinaryService } from "./binary-service";
import { runManagedProcess } from "./process-runner";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function number(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function codec(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(value) && value !== "unknown"
    ? value
    : undefined;
}

export function parseProbeMetadata(value: unknown, fileSize: number, extension = ""): MediaProbe {
  const root = record(value);
  const format = record(root?.["format"]);
  const streams = root?.["streams"];
  if (
    !format ||
    !Array.isArray(streams) ||
    streams.length > 256 ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0
  )
    throw new Error("probeFailed");
  const candidates = streams
    .map(record)
    .filter((stream): stream is Record<string, unknown> => !!stream);
  const video = candidates.find(
    (stream) =>
      stream["codec_type"] === "video" &&
      record(stream["disposition"])?.["attached_pic"] !== 1 &&
      codec(stream["codec_name"]) &&
      Number.isSafeInteger(stream["width"]) &&
      Number(stream["width"]) > 0 &&
      Number.isSafeInteger(stream["height"]) &&
      Number(stream["height"]) > 0,
  );
  const audio = candidates.find(
    (stream) => stream["codec_type"] === "audio" && codec(stream["codec_name"]),
  );
  const names =
    typeof format["format_name"] === "string" &&
    /^[A-Za-z0-9_,.-]{1,160}$/.test(format["format_name"])
      ? format["format_name"].split(",")
      : [];
  if ((!video && !audio) || !names[0]) throw new Error("probeFailed");
  const ext = extension.replace(/^\./, "").toLowerCase();
  const container = names.includes(ext)
    ? ext
    : ext === "mkv" && names.includes("matroska")
      ? "mkv"
      : names[0];
  const duration =
    number(format["duration"]) ?? number(video?.["duration"]) ?? number(audio?.["duration"]);
  const bitrate = number(format["bit_rate"]);
  return {
    container,
    fileSize,
    hasVideo: !!video,
    hasAudio: !!audio,
    ...(duration !== undefined ? { duration } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(video
      ? {
          width: Number(video["width"]),
          height: Number(video["height"]),
          videoCodec: codec(video["codec_name"])!,
        }
      : {}),
    ...(audio ? { audioCodec: codec(audio["codec_name"])! } : {}),
  };
}

async function localMedia(path: string) {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("invalidInput");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) throw new Error("probeFailed");
    await access(path, constants.R_OK);
    return info;
  } catch (error) {
    const code = record(error)?.["code"];
    throw new Error(
      code === "ENOENT"
        ? "fileMissing"
        : code === "EACCES" || code === "EPERM"
          ? "fileAccessDenied"
          : "probeFailed",
    );
  }
}

export class FFmpegService {
  constructor(private readonly binaries: BinaryService) {}

  async probeMedia(filePath: string, signal?: AbortSignal): Promise<MediaProbe> {
    const before = await localMedia(filePath);
    const binary = await this.binaries.getFFprobePath();
    const output = await runManagedProcess(
      binary,
      [
        "-hide_banner",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_entries",
        "format=duration,format_name,bit_rate:stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic",
        "-of",
        "json",
        "-i",
        filePath,
      ],
      {
        timeout: 30_000,
        maxStdout: 1024 * 1024,
        maxStderr: 64 * 1024,
        signal,
        failureCode: "probeFailed",
        timeoutCode: "probeFailed",
      },
    );
    const after = await localMedia(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("fileChanged");
    try {
      return parseProbeMetadata(JSON.parse(output) as unknown, after.size, extname(filePath));
    } catch {
      throw new Error("probeFailed");
    }
  }

  async extractThumbnail(
    filePath: string,
    outputPath: string,
    duration?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await localMedia(filePath);
    if (
      !isAbsolute(outputPath) ||
      outputPath.includes("\0") ||
      extname(outputPath).toLowerCase() !== ".jpg"
    )
      throw new Error("invalidInput");
    const binary = await this.binaries.getFFmpegPath();
    await mkdir(dirname(outputPath), { recursive: true });
    const temporary = join(dirname(outputPath), `.thumbnail-${randomUUID()}.jpg`);
    const seek =
      typeof duration === "number" && Number.isFinite(duration) && duration > 0
        ? Math.min(duration * 0.1, 30)
        : 0;
    try {
      await runManagedProcess(
        binary,
        [
          "-nostdin",
          "-hide_banner",
          "-v",
          "error",
          "-n",
          "-protocol_whitelist",
          "file",
          "-ss",
          String(seek),
          "-i",
          filePath,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=480:270:force_original_aspect_ratio=decrease",
          "-q:v",
          "3",
          "-c:v",
          "mjpeg",
          "-f",
          "image2",
          temporary,
        ],
        {
          timeout: 30_000,
          maxStdout: 4096,
          maxStderr: 64 * 1024,
          signal,
          failureCode: "probeFailed",
          timeoutCode: "probeFailed",
        },
      );
      await localMedia(temporary);
      if (signal?.aborted) throw new Error("cancelled");
      await link(temporary, outputPath);
    } catch (error) {
      if (
        error instanceof Error &&
        ["cancelled", "binaryMissing", "binaryInvalid"].includes(error.message)
      )
        throw error;
      throw new Error("probeFailed");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
