// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  consumeResponse,
  LATEST_RELEASE_URL,
  officialResponse,
  officialText,
} from "./ytdlp-official-http";

describe("official updater HTTP boundary", () => {
  it.each([
    "http://github.com/yt-dlp/yt-dlp/releases/download/2026.10.06/yt-dlp.exe",
    "https://github.com.evil.test/file",
    "https://user:secret@release-assets.githubusercontent.com/file",
    "https://release-assets.githubusercontent.com:444/file",
    "https://github.com/other/project/releases/download/2026.10.06/yt-dlp.exe",
  ])("rejects an untrusted redirect without contacting it", async (target) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location: target } }),
    );
    await expect(
      officialResponse(fetcher, LATEST_RELEASE_URL, new AbortController().signal),
    ).rejects.toThrow("updateFailed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds redirect loops", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location: LATEST_RELEASE_URL } }),
    );
    await expect(
      officialResponse(fetcher, LATEST_RELEASE_URL, new AbortController().signal),
    ).rejects.toThrow("updateFailed");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rejects excessive declared sizes before reading and excessive chunked bodies during reading", async () => {
    const cancel = vi.fn();
    const writer = vi.fn(async () => {});
    await expect(
      consumeResponse(
        new Response(new ReadableStream({ cancel }), { headers: { "content-length": "1000" } }),
        10,
        new AbortController().signal,
        writer,
      ),
    ).rejects.toThrow("updateFailed");
    expect(cancel).toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    await expect(
      consumeResponse(new Response("too large"), 3, new AbortController().signal, writer),
    ).rejects.toThrow("updateFailed");
    expect(writer).not.toHaveBeenCalled();
  });
  it("writes large incoming chunks in bounded slices", async () => {
    const writer = vi.fn(async (_chunk: Uint8Array) => {});
    expect(
      await consumeResponse(
        new Response(new Uint8Array(256 * 1024)),
        300 * 1024,
        new AbortController().signal,
        writer,
      ),
    ).toBe(256 * 1024);
    expect(writer).toHaveBeenCalledTimes(4);
    expect(writer.mock.calls.every(([chunk]) => chunk.byteLength <= 64 * 1024)).toBe(true);
  });
  it("maps a broken response body to a safe connectivity error", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("raw socket address secret"));
            },
          }),
        ),
    );
    await expect(
      officialText(fetcher, LATEST_RELEASE_URL, new AbortController().signal),
    ).rejects.toThrow(/^networkUnavailable$/);
  });
});
