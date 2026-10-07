// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadJob } from "../../shared/models";
import { BinaryService, runYtDlpProcess } from "../services/binary-service";
import { runManagedProcess } from "../services/process-runner";
import { YtDlpService } from "./ytdlp-service";
vi.mock("../services/binary-service", async (original) => ({
  ...(await original<typeof import("../services/binary-service")>()),
  runYtDlpProcess: vi.fn(),
}));
vi.mock("../services/process-runner", () => ({ runManagedProcess: vi.fn() }));

describe("yt-dlp operations reserve the active version", () => {
  let binaries: BinaryService;
  let service: YtDlpService;
  beforeEach(() => {
    vi.resetAllMocks();
    binaries = new BinaryService({ isPackaged: true, resourcesPath: "unused", appPath: "unused" });
    vi.spyOn(binaries, "getYtDlpPath").mockResolvedValue("yt-dlp.exe");
    vi.spyOn(binaries, "getFFmpegPath").mockResolvedValue("ffmpeg.exe");
    vi.spyOn(binaries, "getFFprobePath").mockResolvedValue("ffprobe.exe");
    service = new YtDlpService(binaries);
  });
  it("holds a lease throughout analysis and releases it after process failure", async () => {
    vi.mocked(runYtDlpProcess).mockImplementation(async () => {
      expect(binaries.getYtDlpBusy()).toBe(true);
      await expect(binaries.withYtDlpUpdate(async () => undefined)).rejects.toThrow("updateBusy");
      throw new Error("analysisFailed");
    });
    await expect(service.analyze("https://example.test/watch")).rejects.toThrow("analysisFailed");
    expect(binaries.getYtDlpBusy()).toBe(false);
  });
  it("holds a lease through download cleanup and releases it after cancellation", async () => {
    vi.mocked(runManagedProcess).mockImplementation(async () => {
      expect(binaries.getYtDlpBusy()).toBe(true);
      await expect(binaries.withYtDlpUpdate(async () => undefined)).rejects.toThrow("updateBusy");
      throw new Error("cancelled");
    });
    const job: DownloadJob = {
      id: "job",
      sourceUrl: "https://example.test/media.mp4",
      title: "Media",
      quality: "best",
      container: "original",
      destinationDirectory: "unused",
      downloadedBytes: 0,
      progress: 0,
      status: "queued",
      createdAt: 1,
      updatedAt: 1,
      attempts: 0,
      fromAnalysis: false,
    };
    await expect(
      service.download(job, "unused", () => {}, new AbortController().signal),
    ).rejects.toThrow("cancelled");
    expect(binaries.getYtDlpBusy()).toBe(false);
  });
  it("does not launch an analysis cancelled while activation owns the executable", async () => {
    let release!: () => void;
    const activation = binaries.withYtDlpUpdate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const outcome = service
      .analyze("https://example.test/watch", controller.signal)
      .catch((error: Error) => error.message);
    controller.abort();
    expect(await outcome).toBe("cancelled");
    expect(runYtDlpProcess).not.toHaveBeenCalled();
    release();
    await activation;
  });
});
