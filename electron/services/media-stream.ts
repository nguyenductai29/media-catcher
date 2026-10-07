import { open } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";

const contentTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
};
/** Called only after app-protocol resolves and validates a known database record. */
export async function streamMediaFile(
  path: string,
  range: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || !Number.isSafeInteger(info.size))
      throw new Error("fileMissing");
    let start = 0,
      end = info.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let valid = !!match && !!(match[1] || match[2]);
      if (valid && match) {
        if (!match[1]) {
          const suffix = Number(match[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, info.size - suffix);
        } else {
          start = Number(match[1]);
          const requestedEnd = match[2] ? Number(match[2]) : end;
          valid =
            Number.isSafeInteger(start) &&
            Number.isSafeInteger(requestedEnd) &&
            requestedEnd >= start &&
            start < info.size;
          end = Math.min(requestedEnd, end);
        }
      }
      if (!valid) {
        await handle.close();
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" },
        });
      }
    }
    const source = handle.createReadStream({
      start,
      end,
      autoClose: true,
      highWaterMark: 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    // Size the web-stream queue in bytes, not number of chunks, so backpressure
    // cannot accumulate a large video while Chromium consumes it slowly.
    const body = Readable.toWeb(source, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
      },
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
