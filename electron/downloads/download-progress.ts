import type { DownloadJob, DownloadStatus } from "../../shared/models";

export interface DownloadProgress {
  status: Extract<DownloadStatus, "analyzing" | "downloading" | "processing">;
  downloadedBytes?: number;
  totalBytes?: number;
  progress?: number;
  speed?: number;
  eta?: number;
  outputPath?: string;
}
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export function parseDownloadProgress(line: string): DownloadProgress | undefined {
  if (line.startsWith("MV_PROCESS:")) return { status: "processing" };
  if (!line.startsWith("MV_PROGRESS:")) return undefined;
  try {
    const value = JSON.parse(line.slice(12)) as Record<string, unknown>;
    if (!value || !nonnegative(value["downloaded_bytes"])) return undefined;
    const downloadedBytes = Math.floor(value["downloaded_bytes"]);
    const total = value["total_bytes"] ?? value["total_bytes_estimate"];
    const totalBytes = nonnegative(total) && total > 0 ? Math.floor(total) : undefined;
    return {
      status: value["status"] === "finished" ? "processing" : "downloading",
      downloadedBytes,
      progress: totalBytes ? Math.min(99.9, (downloadedBytes / totalBytes) * 100) : 0,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(nonnegative(value["speed"]) ? { speed: value["speed"] } : {}),
      ...(nonnegative(value["eta"]) ? { eta: value["eta"] } : {}),
    };
  } catch {
    return undefined;
  }
}
export function validDownloadUrl(value: string): boolean {
  if (value.length > 16384 || /[\s\p{Cc}\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function buildDownloadArgs(
  job: DownloadJob,
  tempDirectory: string,
  ffmpegPath: string,
): string[] {
  if (!validDownloadUrl(job.sourceUrl)) throw new Error("invalidUrl");
  let selector = "bv*+ba/b";
  if (job.quality === "selected" && job.fromAnalysis) {
    if (!job.formatId || !/^[a-z0-9_.-]{1,200}$/i.test(job.formatId))
      throw new Error("invalidInput");
    selector = `${job.formatId}+ba/${job.formatId}`;
  } else if (/^(2160|1440|1080|720|480)$/.test(job.quality))
    selector = `bv*[height<=${job.quality}]+ba/b[height<=${job.quality}]`;
  else if (job.quality === "audio") selector = "ba/b";
  const args = [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-cache-dir",
    "--no-playlist",
    "--no-simulate",
    "--no-warnings",
    "--newline",
    "--no-colors",
    "--progress",
    "--progress-delta",
    "0.2",
    "--progress-template",
    "download:MV_PROGRESS:%(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta})j",
    "--progress-template",
    "postprocess:MV_PROCESS:%(progress.status)j",
    "--print",
    "after_move:MV_COMPLETE:%(filepath)j",
    "--continue",
    "--no-overwrites",
    "--no-mtime",
    "--windows-filenames",
    "--socket-timeout",
    "20",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--ffmpeg-location",
    ffmpegPath,
    "--paths",
    tempDirectory,
    "--output",
    "media.%(ext)s",
    "--format",
    selector,
  ];
  if (job.quality === "audio") args.push("--extract-audio", "--audio-format", "best");
  else if (job.container !== "original")
    args.push("--merge-output-format", job.container, "--remux-video", job.container);
  args.push("--", job.sourceUrl);
  return args;
}
