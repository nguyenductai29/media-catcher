import { createHash } from "node:crypto";
import type { DetectedMedia, PageAnalysis } from "../../shared/models";
import { BinaryService, runYtDlpProcess } from "../services/binary-service";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit = 1_024): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Preserve the exact signed URL after validation; URL.toString can change signatures. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16_384 || /[\s\p{Cc}]/u.test(value))
    return undefined;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function drm(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function parseFormat(value: unknown, sourceUrl: string, title: string): DetectedMedia | undefined {
  if (!record(value) || drm(value["has_drm"])) return undefined;
  const url = webUrl(value["url"]);
  if (!url) return undefined;
  const protocol = text(value["protocol"], 80)?.toLowerCase();
  const container = text(value["ext"], 30)?.toLowerCase();
  const vcodec = text(value["vcodec"], 160);
  const acodec = text(value["acodec"], 160);
  if (
    protocol === "mhtml" ||
    vcodec === "images" ||
    /storyboard/i.test(text(value["format_note"]) ?? "") ||
    /^(?:jpg|jpeg|png|webp|gif|mhtml)$/.test(container ?? "")
  )
    return undefined;
  if (vcodec === "none" && acodec === "none") return undefined;
  if (
    protocol &&
    !/^(?:https?|http_dash_segments|m3u8(?:_native)?|dash|http_pseudo)$/.test(protocol)
  )
    return undefined;
  const rawId = value["format_id"];
  if (rawId !== undefined && (typeof rawId !== "string" || !rawId || rawId.length > 200))
    return undefined;
  const formatId = typeof rawId === "string" ? rawId : "direct";
  const width = number(value["width"]);
  const height = number(value["height"]);
  const bitrate = number(value["tbr"]) ?? number(value["abr"]);
  const size = number(value["filesize"]) ?? number(value["filesize_approx"]);
  const path = new URL(url).pathname;
  const type: DetectedMedia["type"] =
    /m3u8/.test(protocol ?? "") || /\.m3u8$/i.test(path)
      ? "hls"
      : /dash/.test(protocol ?? "") || /\.mpd$/i.test(path)
        ? "dash"
        : vcodec === "none" || /^(?:mp3|m4a|aac|opus|ogg|flac|wav)$/.test(container ?? "")
          ? "audio"
          : vcodec && vcodec !== "none"
            ? "video"
            : "direct";
  const codec = [vcodec, acodec].filter((value) => value && value !== "none").join(" / ");
  return {
    id: `analysis-${createHash("sha256").update(`${formatId}\0${url}`).digest("hex").slice(0, 24)}`,
    url,
    sourcePageUrl: sourceUrl,
    title,
    type,
    origin: "analysis",
    formatId,
    detectedAt: Date.now(),
    ...(width !== undefined && width > 0 ? { width } : {}),
    ...(height !== undefined && height > 0
      ? { height, resolution: width && width > 0 ? `${width}×${height}` : `${height}p` }
      : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(size !== undefined ? { estimatedSize: size } : {}),
    ...(container ? { container } : {}),
    ...(codec ? { codec } : {}),
    ...(acodec ? { hasAudio: acodec !== "none" } : {}),
  };
}

/** Convert untrusted extractor JSON to the bounded, renderer-safe contract. */
export function parseYtDlpMetadata(value: unknown, sourceUrl: string): PageAnalysis {
  if (
    !record(value) ||
    !webUrl(sourceUrl) ||
    (value["formats"] !== undefined && !Array.isArray(value["formats"])) ||
    value["_type"] === "playlist" ||
    value["_type"] === "multi_video" ||
    "entries" in value
  ) {
    throw new Error("analysisFailed");
  }
  const title = text(value["title"]) ?? new URL(sourceUrl).hostname;
  const webpageUrl = webUrl(value["webpage_url"]) ?? sourceUrl;
  const thumbnail = webUrl(value["thumbnail"]);
  const duration = number(value["duration"]);
  const uploader = text(value["uploader"]);
  const website = text(value["extractor_key"], 200) ?? text(value["extractor"], 200);
  const candidates: unknown[] = Array.isArray(value["formats"]) ? value["formats"] : [value];
  const allProtected = drm(value["has_drm"]);
  let drmProtected = allProtected;
  const formats: DetectedMedia[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (record(candidate) && drm(candidate["has_drm"])) drmProtected = true;
    if (allProtected || formats.length === 200) continue;
    const format = parseFormat(candidate, sourceUrl, title);
    if (!format || seen.has(format.id)) continue;
    seen.add(format.id);
    formats.push(format);
  }
  const subtitles = new Set<string>();
  for (const field of [value["subtitles"], value["automatic_captions"]]) {
    if (!record(field)) continue;
    for (const [language, tracks] of Object.entries(field)) {
      if (subtitles.size >= 100) break;
      if (/^[\w-]{1,35}$/.test(language) && Array.isArray(tracks)) subtitles.add(language);
    }
  }
  return {
    title,
    webpageUrl,
    formats,
    drmProtected,
    subtitles: [...subtitles],
    ...(thumbnail ? { thumbnail } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(uploader ? { uploader } : {}),
    ...(website ? { website } : {}),
  };
}

export class YtDlpService {
  constructor(private readonly binaryService: BinaryService) {}

  async analyze(url: string, signal?: AbortSignal): Promise<PageAnalysis> {
    if (!webUrl(url)) throw new Error("invalidUrl");
    if (signal?.aborted) throw new Error("cancelled");
    const binary = await this.binaryService.getYtDlpPath();
    const output = await runYtDlpProcess(
      binary,
      [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--no-warnings",
        "--no-cache-dir",
        "--socket-timeout",
        "15",
        "--",
        url,
      ],
      { timeout: 45_000, maxStdout: 8 * 1024 * 1024, maxStderr: 64 * 1024, signal },
    );
    let metadata: unknown;
    try {
      metadata = JSON.parse(output);
    } catch {
      throw new Error("analysisFailed");
    }
    const result = parseYtDlpMetadata(metadata, url);
    if (result.formats.length === 0)
      throw new Error(result.drmProtected ? "drmProtected" : "analysisFailed");
    return result;
  }
}
