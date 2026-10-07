// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildDownloadArgs, parseDownloadProgress } from "./download-progress";
import type { DownloadJob } from "../../shared/models";
const job: DownloadJob = {
  id: "id",
  sourceUrl: "https://example.com/movie?token=secret",
  title: "A movie",
  destinationDirectory: "C:\\Videos",
  quality: "best",
  container: "mp4",
  downloadedBytes: 0,
  progress: 0,
  status: "queued",
  createdAt: 1,
  updatedAt: 1,
  attempts: 0,
  fromAnalysis: false,
};
describe("structured yt-dlp download boundary", () => {
  it("maps structured progress without parsing human output or marking complete", () => {
    expect(
      parseDownloadProgress(
        'MV_PROGRESS:{"status":"downloading","downloaded_bytes":20,"total_bytes":100,"speed":7,"eta":12}',
      ),
    ).toEqual({
      status: "downloading",
      downloadedBytes: 20,
      totalBytes: 100,
      progress: 20,
      speed: 7,
      eta: 12,
    });
    expect(
      parseDownloadProgress(
        'MV_PROGRESS:{"status":"finished","downloaded_bytes":100,"total_bytes":100}',
      )?.status,
    ).toBe("processing");
    for (const line of [
      "[download] 50% 1MB/s",
      "MV_PROGRESS:{bad",
      'MV_PROGRESS:{"downloaded_bytes":-1}',
    ])
      expect(parseDownloadProgress(line)).toBeUndefined();
  });
  it("uses constrained selectors, continuation, isolated paths and no implicit config", () => {
    const args = buildDownloadArgs(job, "C:\\Temp\\job", "C:\\Tools\\ffmpeg.exe");
    expect(args).toContain("--ignore-config");
    expect(args).toContain("--no-plugin-dirs");
    expect(args).toContain("--continue");
    expect(args).toContain("--keep-video");
    expect(args.slice(-2)).toEqual(["--", job.sourceUrl]);
    expect(args).toContain("bv*+ba/b");
    expect(args).toContain("--remux-video");
    expect(args).not.toContain("--recode-video");
    expect(args).not.toContain("--cookies-from-browser");
    expect(buildDownloadArgs({ ...job, quality: "1080" }, "temp", "ffmpeg")).toContain(
      "bv*[height<=1080]+ba/b[height<=1080]",
    );
    expect(() =>
      buildDownloadArgs(
        { ...job, fromAnalysis: true, quality: "selected", formatId: "best/../bad" },
        "temp",
        "ffmpeg",
      ),
    ).toThrow("invalidInput");
    expect(() =>
      buildDownloadArgs({ ...job, sourceUrl: "file:///secret" }, "temp", "ffmpeg"),
    ).toThrow("invalidUrl");
  });
});
