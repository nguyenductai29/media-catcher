import { MAX_BINARY_BYTES, throwIfAborted, validReleaseVersion } from "./ytdlp-update-store";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const MAX_TEXT_BYTES = 1024 * 1024;
const assetHosts = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function officialUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("updateFailed");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
    throw new Error("updateFailed");
  if (url.hostname === "api.github.com" && url.href === LATEST_RELEASE_URL) return url;
  if (
    url.hostname === "github.com" &&
    !url.search &&
    /^\/yt-dlp\/yt-dlp\/releases\/download\/20\d{2}\.\d{2}\.\d{2}(?:\.\d{1,3})?\/(?:yt-dlp\.exe|SHA2-256SUMS)$/.test(
      url.pathname,
    )
  )
    return url;
  if (assetHosts.has(url.hostname)) return url;
  throw new Error("updateFailed");
}

export async function officialResponse(
  fetchImpl: typeof fetch,
  input: string,
  signal: AbortSignal,
): Promise<Response> {
  let url = officialUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: {
          "User-Agent": "MediaVault",
          Accept:
            url.hostname === "api.github.com"
              ? "application/vnd.github+json"
              : "application/octet-stream",
        },
      });
    } catch {
      throw new Error(signal.aborted ? "cancelled" : "networkUnavailable");
    }
    try {
      if (response.url) officialUrl(response.url);
    } catch {
      void response.body?.cancel().catch(() => {});
      throw new Error("updateFailed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("updateFailed");
      url = officialUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new Error(
        response.status === 429 || response.status >= 500 ? "networkUnavailable" : "updateFailed",
      );
    }
    return response;
  }
  throw new Error("updateFailed");
}

/** Bound each HTTP body, including chunked responses; cancellation never waits for a stalled peer. */
export async function consumeResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => {});
    throw new Error("updateFailed");
  }
  if (!response.body) throw new Error("updateFailed");
  const reader = response.body.getReader();
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new Error(signal.aborted ? "cancelled" : "networkUnavailable");
      }
      const { value, done } = result;
      throwIfAborted(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error("updateFailed");
      for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
        throwIfAborted(signal);
        await consume(value.subarray(offset, Math.min(offset + 64 * 1024, value.byteLength)));
      }
    }
    return total;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function officialText(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const parts: Buffer[] = [];
  await consumeResponse(
    await officialResponse(fetchImpl, url, signal),
    MAX_TEXT_BYTES,
    signal,
    async (chunk) => {
      parts.push(Buffer.from(chunk));
    },
  );
  return Buffer.concat(parts).toString("utf8");
}

export interface OfficialRelease {
  version: string;
  binaryUrl: string;
  checksumUrl: string;
  size: number;
}
export async function latestRelease(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<OfficialRelease> {
  let raw: unknown;
  try {
    raw = JSON.parse(await officialText(fetchImpl, LATEST_RELEASE_URL, signal)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("updateFailed");
    throw error;
  }
  if (!raw || typeof raw !== "object") throw new Error("updateFailed");
  const data = raw as Record<string, unknown>;
  if (
    !validReleaseVersion(data["tag_name"]) ||
    data["draft"] !== false ||
    data["prerelease"] !== false ||
    !Array.isArray(data["assets"]) ||
    data["assets"].length > 1_000
  )
    throw new Error("updateFailed");
  const version = data["tag_name"];
  const candidates = data["assets"].filter(
    (value: unknown) =>
      value && typeof value === "object" && "name" in value && value.name === "yt-dlp.exe",
  ) as Record<string, unknown>[];
  const asset = candidates[0];
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
  if (
    candidates.length !== 1 ||
    !asset ||
    asset["browser_download_url"] !== `${base}/yt-dlp.exe` ||
    !Number.isSafeInteger(asset["size"]) ||
    typeof asset["size"] !== "number" ||
    asset["size"] <= 0 ||
    asset["size"] > MAX_BINARY_BYTES
  )
    throw new Error("updateFailed");
  return {
    version,
    binaryUrl: `${base}/yt-dlp.exe`,
    checksumUrl: `${base}/SHA2-256SUMS`,
    size: asset["size"],
  };
}

export function releaseChecksum(text: string): string {
  const hashes = text
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64}) [ *]yt-dlp\.exe$/.exec(line)?.[1])
    .filter((value): value is string => !!value);
  if (hashes.length !== 1) throw new Error("updateFailed");
  return hashes[0]!.toLowerCase();
}
