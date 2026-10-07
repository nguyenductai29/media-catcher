import { createHash } from "node:crypto";
import type { DetectedMedia } from "../../shared/models";
import { normalizeBrowserUrl } from "./url";

export function classifyMedia(
  input: string,
  contentType?: string,
): { type: DetectedMedia["type"]; container?: string } | null {
  let url: URL;
  try {
    url = new URL(normalizeBrowserUrl(input));
  } catch {
    return null;
  }
  const ext = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (["ts", "m4s", "cmfv", "cmfa"].includes(ext ?? "") || mime === "video/mp2t") return null;
  if (mime?.startsWith("text/") || mime?.includes("json")) return null;
  if (
    ext === "m3u8" ||
    [
      "application/vnd.apple.mpegurl",
      "application/x-mpegurl",
      "audio/mpegurl",
      "audio/x-mpegurl",
    ].includes(mime ?? "")
  )
    return { type: "hls", container: "HLS" };
  if (ext === "mpd" || mime === "application/dash+xml") return { type: "dash", container: "DASH" };
  if (
    mime?.startsWith("audio/") ||
    ["aac", "m4a", "mp3", "ogg", "opus", "wav", "flac"].includes(ext ?? "")
  )
    return { type: "audio", ...(ext ? { container: ext.toUpperCase() } : {}) };
  if (mime?.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(ext ?? ""))
    return { type: "video", ...(ext ? { container: ext.toUpperCase() } : {}) };
  return null;
}

export class MediaCandidates {
  private items = new Map<string, DetectedMedia>();
  constructor(private limit = 200) {}
  clear() {
    this.items.clear();
  }
  list() {
    return [...this.items.values()];
  }
  addNetwork(url: string, page: string, mimeType?: string, size?: number): boolean {
    const kind = classifyMedia(url, mimeType);
    if (!kind) return false;
    const normalized = normalizeBrowserUrl(url);
    const key = normalized.split("#")[0] ?? normalized;
    const analyzed = [...this.items.values()].filter(
      (item) => item.origin === "analysis" && (item.url.split("#")[0] ?? item.url) === key,
    );
    if (analyzed.length) {
      if (size && Number.isFinite(size) && size > 0)
        for (const item of analyzed) item.estimatedSize = Math.max(size, item.estimatedSize ?? 0);
      return true;
    }
    const existing = this.items.get(key);
    if (!existing && this.items.size >= this.limit) return false;
    const item: DetectedMedia = {
      id: createHash("sha256").update(key).digest("hex").slice(0, 24),
      url: normalized,
      sourcePageUrl: page,
      ...kind,
      origin: "network",
      detectedAt: existing?.detectedAt ?? Date.now(),
      ...(mimeType ? { mimeType: mimeType.split(";")[0]!.slice(0, 100) } : {}),
      ...(size && Number.isFinite(size) && size > 0
        ? { estimatedSize: Math.max(size, existing?.estimatedSize ?? 0) }
        : {}),
    };
    this.items.set(key, { ...existing, ...item });
    return true;
  }
  merge(formats: DetectedMedia[]) {
    // Replace previous analysis results; signed URLs and format IDs remain distinct.
    for (const [key, item] of this.items) if (item.origin === "analysis") this.items.delete(key);
    for (const item of formats) {
      const urlKey = item.url.split("#")[0] ?? item.url;
      const network = this.items.get(urlKey);
      if (network?.origin === "network") this.items.delete(urlKey);
      const key = `${urlKey}|${item.formatId ?? ""}`;
      if (this.items.size < this.limit || this.items.has(key)) this.items.set(key, item);
    }
  }
}
