// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YtDlpService } from "./ytdlp-service";
import { BinaryService, runYtDlpProcess } from "../services/binary-service";
import { runManagedProcess } from "../services/process-runner";
import { ProcessFailure } from "../services/process-failure";
import { BrowserCookieBridge } from "../browser/browser-cookie-bridge";
import { parseCookieMetadata } from "../browser/cookie-metadata";
import type { DownloadJob } from "../../shared/models";
vi.mock("../services/binary-service", async (original) => ({
  ...(await original<typeof import("../services/binary-service")>()),
  runYtDlpProcess: vi.fn(),
}));
vi.mock("../services/process-runner", () => ({ runManagedProcess: vi.fn() }));
const url = "https://example.test/movie";
const cookie = {
  domain: "example.test",
  path: "/",
  name: "session",
  value: "private-login",
  secure: true,
  httpOnly: true,
  session: true,
  hostOnly: true,
  sameSite: "lax" as const,
};
const output = JSON.stringify({
  title: "Movie",
  url: "https://example.test/video.mp4",
  ext: "mp4",
});
describe("yt-dlp authenticated operation integration", () => {
  let directory: string;
  let cookieDirectory: string;
  let bridge: BrowserCookieBridge;
  let service: YtDlpService;
  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), "mediavault-yt-auth-"));
    cookieDirectory = join(directory, "cookies");
    bridge = new BrowserCookieBridge({ directory: cookieDirectory });
    await bridge.initialize();
    bridge.bind({
      cookies: { get: async () => [cookie] },
      currentPage: () => ({ url, generation: 1, loading: false }),
      metadata: async () => parseCookieMetadata({ cookies: [{ ...cookie, expires: -1 }] }),
    });
    const binaries = new BinaryService({
      isPackaged: false,
      appPath: directory,
      resourcesPath: directory,
    });
    vi.spyOn(binaries, "getYtDlpPath").mockResolvedValue("yt-dlp.exe");
    vi.spyOn(binaries, "getFFmpegPath").mockResolvedValue("ffmpeg.exe");
    vi.spyOn(binaries, "getFFprobePath").mockResolvedValue("ffprobe.exe");
    service = new YtDlpService(binaries, bridge);
  });
  afterEach(async () => {
    await bridge.shutdown();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it("tries public analysis first and marks only successful authenticated fallback formats", async () => {
    vi.mocked(runYtDlpProcess).mockRejectedValueOnce(new ProcessFailure("analysisFailed", true));
    vi.mocked(runYtDlpProcess).mockImplementationOnce(async (_binary, args) => {
      const path = args[args.indexOf("--cookies") + 1]!;
      expect(await readFile(path, "utf8")).toContain("private-login");
      expect(args.slice(-2)).toEqual(["--", url]);
      return output;
    });
    const result = await service.analyze(url);
    expect(result.formats[0]?.requiresBrowserSession).toBe(true);
    expect(vi.mocked(runYtDlpProcess).mock.calls[0]?.[1]).not.toContain("--cookies");
    expect(JSON.stringify(result)).not.toContain("private-login");
    expect(await readdir(cookieDirectory)).toEqual([]);
  });
  it.each([
    "analysisFailed",
    "analysisTimeout",
    "drmProtected",
    "networkUnavailable",
    "binaryMissing",
  ] as const)("does not retry %s without an auth classification", async (code) => {
    vi.mocked(runYtDlpProcess).mockRejectedValue(new Error(code));
    await expect(service.analyze(url)).rejects.toThrow(code);
    expect(runYtDlpProcess).toHaveBeenCalledOnce();
    expect(await readdir(cookieDirectory)).toEqual([]);
  });
  it("does not retry repeatedly or create cookies for public success", async () => {
    vi.mocked(runYtDlpProcess).mockResolvedValueOnce(output);
    expect((await service.analyze(url)).formats[0]?.requiresBrowserSession).toBeUndefined();
    vi.mocked(runYtDlpProcess).mockRejectedValue(new ProcessFailure("analysisFailed", true));
    await expect(service.analyze(url)).rejects.toThrow(/^browserSessionRequired$/);
    expect(runYtDlpProcess).toHaveBeenCalledTimes(3);
    expect(await readdir(cookieDirectory)).toEqual([]);
  });
  it("exports fresh cookies only around a saved job's process and removes them on failure", async () => {
    const work = join(directory, "job");
    await mkdir(work);
    const job: DownloadJob = {
      id: "id",
      sourceUrl: url,
      pageUrl: url,
      title: "Movie",
      quality: "best",
      container: "original",
      destinationDirectory: directory,
      downloadedBytes: 0,
      progress: 0,
      status: "queued",
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      fromAnalysis: false,
    };
    const files: string[] = [];
    const progress = vi.fn((value: { requiresBrowserSession?: true }) => {
      if (value.requiresBrowserSession) job.requiresBrowserSession = true;
    });
    vi.mocked(runManagedProcess).mockImplementation(async (_binary, args, options) => {
      const path = args[args.indexOf("--cookies") + 1]!;
      files.push(path);
      expect(progress).toHaveBeenLastCalledWith({
        status: "analyzing",
        requiresBrowserSession: true,
      });
      expect(await readFile(path, "utf8")).toContain("private-login");
      expect(args.slice(-2)).toEqual(["--", url]);
      if (files.length === 1) throw new Error("networkUnavailable");
      const media = join(work, "media.mp4");
      await writeFile(media, "media");
      options.onStdoutLine?.(`MV_COMPLETE:${JSON.stringify(media)}`);
      return "";
    });
    await expect(
      service.download(job, work, progress, new AbortController().signal),
    ).rejects.toThrow("networkUnavailable");
    expect(await readdir(cookieDirectory)).toEqual([]);
    expect(job.requiresBrowserSession).toBe(true);
    bridge.bind({
      cookies: { get: async () => [cookie] },
      currentPage: () => ({ url: "https://unrelated.test", generation: 2, loading: false }),
      metadata: async () => parseCookieMetadata({ cookies: [{ ...cookie, expires: -1 }] }),
    });
    await service.download(job, work, progress, new AbortController().signal);
    expect(new Set(files).size).toBe(2);
    expect(await readdir(cookieDirectory)).toEqual([]);
    expect(JSON.stringify(job)).not.toContain(cookieDirectory);
  });
});
