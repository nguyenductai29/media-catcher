// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAppProtocol } from "./app-protocol";
import { resolve } from "node:path";
describe("private media protocol", () => {
  it("serves only known IDs from the trusted shell and forwards byte ranges", async () => {
    const validateKnownFile = vi.fn(async () => resolve("movie.mp4"));
    const fetchFile = vi.fn(
      async (_url: string, _options?: { headers: Record<string, string> }) =>
        new Response("video", { status: 206 }),
    );
    const streamMedia = vi.fn(
      async (_path: string, _range: string | null, _signal?: AbortSignal) =>
        new Response("video", { status: 206 }),
    );
    const handler = createAppProtocol({
      rendererRoot: resolve("dist-desktop"),
      thumbnailDirectory: resolve("thumbs"),
      trustedOrigin: "mediavault://app",
      library: { validateKnownFile, get: vi.fn() },
      fetchFile,
      streamMedia,
    });
    const request = Object.assign(
      new Request("mediavault://media/known-id/video", { headers: { range: "bytes=0-10" } }),
      { initiatorOrigin: "mediavault://app" },
    );
    expect((await handler(request)).status).toBe(206);
    expect(validateKnownFile).toHaveBeenCalledWith("known-id");
    expect(streamMedia.mock.calls[0]?.[1]).toBe("bytes=0-10");
    expect(fetchFile).not.toHaveBeenCalled();
    for (const origin of ["https://evil.test", "file://", "null", undefined]) {
      expect(
        (
          await handler(
            Object.assign(new Request("mediavault://media/known-id/video"), {
              initiatorOrigin: origin,
            }),
          )
        ).status,
      ).toBe(403);
    }
  });
  it("rejects arbitrary filesystem paths, unknown resources and missing records", async () => {
    const handler = createAppProtocol({
      rendererRoot: resolve("dist-desktop"),
      thumbnailDirectory: resolve("thumbs"),
      trustedOrigin: "mediavault://app",
      library: {
        validateKnownFile: async () => {
          throw new Error("fileMissing");
        },
        get: vi.fn(),
      },
      fetchFile: async () => new Response(),
    });
    for (const url of [
      "mediavault://media/C:/secret.mp4",
      "mediavault://media/id/video?path=C:/secret",
      "mediavault://media/id/other",
      "mediavault://media/missing/video",
    ]) {
      expect(
        (await handler(Object.assign(new Request(url), { initiatorOrigin: "mediavault://app" })))
          .status,
      ).toBeGreaterThanOrEqual(400);
    }
  });
  it("returns not found when a validated file disappears before streaming starts", async () => {
    const handler = createAppProtocol({
      rendererRoot: resolve("dist-desktop"),
      thumbnailDirectory: resolve("thumbs"),
      trustedOrigin: "mediavault://app",
      library: { validateKnownFile: async () => resolve("movie.mp4"), get: vi.fn() },
      streamMedia: async () => {
        throw new Error("fileMissing");
      },
      fetchFile: async () => {
        throw new Error("fileMissing");
      },
    });
    const request = Object.assign(new Request("mediavault://media/known-id/video"), {
      initiatorOrigin: "mediavault://app",
    });
    await expect(handler(request)).resolves.toMatchObject({ status: 404 });
    await expect(handler(new Request("mediavault://app/missing.js"))).resolves.toMatchObject({
      status: 404,
    });
  });
});
