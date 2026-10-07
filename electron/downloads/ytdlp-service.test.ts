// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinaryService } from "../services/binary-service";
import { parseYtDlpMetadata, YtDlpService } from "./ytdlp-service";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const sourceUrl = "https://example.com/watch?v=abc";
const video = {
  format_id: "137",
  url: "https://cdn.example.com/video.mp4?token=a%2Fb&part=1",
  ext: "mp4",
  vcodec: "avc1.640028",
  acodec: "none",
  width: 1920,
  height: 1080,
  tbr: 4200,
  filesize: 12_000_000,
};

describe("parseYtDlpMetadata", () => {
  it("keeps distinct signed format URLs and useful typed metadata", () => {
    const result = parseYtDlpMetadata(
      {
        title: "A video",
        webpage_url: sourceUrl,
        duration: 90.5,
        uploader: "Author",
        extractor_key: "Generic",
        thumbnail: "https://cdn.example.com/poster.jpg",
        subtitles: { en: [{ url: "https://cdn.example.com/en.vtt" }] },
        automatic_captions: { vi: [] },
        formats: [video, { ...video, url: "https://cdn.example.com/video.mp4?token=other" }],
      },
      sourceUrl,
    );
    expect(result).toMatchObject({
      title: "A video",
      webpageUrl: sourceUrl,
      duration: 90.5,
      uploader: "Author",
      website: "Generic",
      subtitles: ["en", "vi"],
      drmProtected: false,
    });
    expect(result.formats).toHaveLength(2);
    expect(result.formats[0]).toMatchObject({
      url: video.url,
      formatId: "137",
      origin: "analysis",
      sourcePageUrl: sourceUrl,
      type: "video",
      width: 1920,
      height: 1080,
      resolution: "1920×1080",
      bitrate: 4200,
      estimatedSize: 12_000_000,
      container: "mp4",
      hasAudio: false,
    });
    expect(result.formats[0]?.id).not.toBe(result.formats[1]?.id);
  });

  it("classifies audio and manifest formats and removes duplicate format identities", () => {
    const result = parseYtDlpMetadata(
      {
        title: "Media",
        formats: [
          { ...video, format_id: "audio", vcodec: "none", acodec: "opus" },
          { ...video, format_id: "hls", protocol: "m3u8_native" },
          { ...video, format_id: "dash", protocol: "http_dash_segments" },
          video,
          video,
        ],
      },
      sourceUrl,
    );
    expect(result.formats.map((format) => format.type)).toEqual(["audio", "hls", "dash", "video"]);
    expect(result.formats[0]?.hasAudio).toBe(true);
  });

  it("rejects DRM, storyboards, malformed formats, unsafe URLs, and invalid numbers", () => {
    const result = parseYtDlpMetadata(
      {
        title: { unsafe: true },
        duration: -2,
        thumbnail: "file:///secret",
        webpage_url: "javascript:alert(1)",
        formats: [
          null,
          [],
          "wrong",
          { ...video, has_drm: true },
          { ...video, protocol: "mhtml" },
          { ...video, ext: "jpg" },
          { ...video, vcodec: "images" },
          { ...video, format_note: "storyboard" },
          { ...video, vcodec: "none", acodec: "none" },
          { ...video, url: "file:///secret" },
          { ...video, url: "https://user:pass@example.com/a" },
          { ...video, url: "https://cdn.example.com/a\n?token=secret" },
          { ...video, height: "1080", width: -1, tbr: Infinity, filesize: NaN },
        ],
      },
      sourceUrl,
    );
    expect(result.formats).toHaveLength(1);
    expect(result).toMatchObject({
      title: "example.com",
      webpageUrl: sourceUrl,
      drmProtected: true,
    });
    expect(result.thumbnail).toBeUndefined();
    expect(result.duration).toBeUndefined();
    expect(result.formats[0]?.height).toBeUndefined();
    expect(result.formats[0]?.width).toBeUndefined();
    expect(result.formats[0]?.bitrate).toBeUndefined();
    expect(result.formats[0]?.estimatedSize).toBeUndefined();
  });

  it("never offers formats from metadata marked as DRM protected", () => {
    expect(parseYtDlpMetadata({ has_drm: true, formats: [video] }, sourceUrl)).toMatchObject({
      formats: [],
      drmProtected: true,
    });
  });

  it("bounds returned formats and handles a direct extractor result", () => {
    const formats = Array.from({ length: 250 }, (_, index) => ({
      ...video,
      format_id: `${index}`,
    }));
    expect(parseYtDlpMetadata({ formats }, sourceUrl).formats).toHaveLength(200);
    expect(parseYtDlpMetadata({ ...video, title: "Direct" }, sourceUrl).formats).toHaveLength(1);
  });

  it.each([
    null,
    [],
    "secret raw output",
    123,
    { formats: "wrong" },
    { _type: "playlist", entries: [] },
  ])("rejects invalid top-level metadata with a safe error", (value) => {
    expect(() => parseYtDlpMetadata(value, sourceUrl)).toThrow("analysisFailed");
  });
});

class ProcessFixture extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

describe("YtDlpService", () => {
  let child: ProcessFixture;
  let service: YtDlpService;

  beforeEach(() => {
    child = new ProcessFixture();
    spawnMock.mockImplementation(() => {
      child = new ProcessFixture();
      return child;
    });
    const binary = new BinaryService({
      isPackaged: false,
      resourcesPath: process.cwd(),
      appPath: process.cwd(),
    });
    vi.spyOn(binary, "getYtDlpPath").mockResolvedValue("C:/safe/yt-dlp.exe");
    service = new YtDlpService(binary);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function begin(signal?: AbortSignal) {
    const promise = service.analyze(sourceUrl, signal);
    await Promise.resolve();
    return { promise };
  }

  it("analyzes with argument arrays and config/plugins disabled without downloading", async () => {
    const { promise } = await begin();
    child.stdout.write(JSON.stringify({ title: "Result", formats: [video] }));
    child.emit("close", 0);
    expect((await promise).formats[0]?.url).toBe(video.url);
    expect(spawnMock).toHaveBeenCalledWith(
      "C:/safe/yt-dlp.exe",
      expect.arrayContaining([
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--no-warnings",
        "--",
        sourceUrl,
      ]),
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args.slice(-2)).toEqual(["--", sourceUrl]);
    expect(args.some((argument) => argument.includes("cookies"))).toBe(false);
  });

  it("rejects unsafe input before spawning a process", async () => {
    await expect(service.analyze("https://user:password@example.com")).rejects.toThrow(
      "invalidUrl",
    );
    await expect(service.analyze("file:///secret")).rejects.toThrow("invalidUrl");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("cancels a running process and removes abort listeners", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const { promise } = await begin(controller.signal);
    const rejection = expect(promise).rejects.toThrow("cancelled");
    controller.abort();
    await rejection;
    expect(child.kill).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    child.emit("close", 0);
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service.analyze(sourceUrl, controller.signal)).rejects.toThrow("cancelled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not spawn if cancellation happens during binary discovery", async () => {
    const controller = new AbortController();
    const promise = service.analyze(sourceUrl, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow("cancelled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills timed-out analysis and reports only its safe code", async () => {
    vi.useFakeTimers();
    const { promise } = await begin();
    const rejection = expect(promise).rejects.toThrow("analysisTimeout");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(child.kill).toHaveBeenCalled();
  });

  it.each(["stdout", "stderr"] as const)("terminates excessive %s output", async (stream) => {
    const { promise } = await begin();
    const rejection = expect(promise).rejects.toThrow("analysisFailed");
    child[stream].write(Buffer.alloc(9 * 1024 * 1024));
    await rejection;
    expect(child.kill).toHaveBeenCalled();
  });

  it("does not expose raw errors, invalid JSON, or stderr", async () => {
    const first = await begin();
    child.stderr.write("secret signed URL, token, cookie value");
    child.emit("close", 1);
    await expect(first.promise).rejects.toThrow(/^analysisFailed$/);
    const second = await begin();
    child.stdout.write("not JSON, secret");
    child.emit("close", 0);
    await expect(second.promise).rejects.toThrow(/^analysisFailed$/);
  });

  it("classifies DRM failures without returning raw diagnostics", async () => {
    const { promise } = await begin();
    child.stderr.write("ERROR: This video is DRM protected; private_url=secret");
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(/^drmProtected$/);
  });

  it("maps an executable launch failure to a safe error", async () => {
    const { promise } = await begin();
    child.emit("error", Object.assign(new Error("private executable path"), { code: "EACCES" }));
    await expect(promise).rejects.toThrow(/^binaryInvalid$/);
  });

  it("returns a safe error when a binary disappears before spawning", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("private path"), { code: "ENOENT" });
    });
    await expect(service.analyze(sourceUrl)).rejects.toThrow(/^binaryMissing$/);
  });

  it("reports metadata with only protected formats as DRM protected", async () => {
    const { promise } = await begin();
    child.stdout.write(
      JSON.stringify({ title: "Protected", formats: [{ ...video, has_drm: true }] }),
    );
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/^drmProtected$/);
  });

  it("reports metadata without usable formats as an analysis failure", async () => {
    const { promise } = await begin();
    child.stdout.write(JSON.stringify({ title: "Empty", formats: [] }));
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/^analysisFailed$/);
  });

  it("accepts a valid version and rejects arbitrary stdout in the version check", async () => {
    const binary = new BinaryService({
      isPackaged: false,
      resourcesPath: process.cwd(),
      appPath: process.cwd(),
    });
    vi.spyOn(binary, "getYtDlpPath").mockResolvedValue("C:/safe/yt-dlp.exe");
    const valid = binary.checkVersion();
    await Promise.resolve();
    child.stdout.write("2026.01.01\n");
    child.emit("close", 0);
    await expect(valid).resolves.toEqual({ available: true, version: "2026.01.01" });
    const invalid = binary.checkVersion();
    await Promise.resolve();
    child.stdout.write("2026.01.01 secret cookie value");
    child.emit("close", 0);
    await expect(invalid).resolves.toEqual({ available: false, version: null });
  });

  it("bounds version-check time and returns unavailable on timeout", async () => {
    vi.useFakeTimers();
    const binary = new BinaryService({
      isPackaged: false,
      resourcesPath: process.cwd(),
      appPath: process.cwd(),
    });
    vi.spyOn(binary, "getYtDlpPath").mockResolvedValue("C:/safe/yt-dlp.exe");
    const pending = binary.checkVersion();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toEqual({ available: false, version: null });
    expect(child.kill).toHaveBeenCalled();
  });
});
