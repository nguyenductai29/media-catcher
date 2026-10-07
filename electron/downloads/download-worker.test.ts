// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadJob, MediaProbe } from "../../shared/models";
import type { FFmpegService } from "../services/ffmpeg-service";
import type { DownloadSettingsService } from "../services/download-settings-service";
import type { YtDlpService } from "./ytdlp-service";
import type { DownloadProgress } from "./download-progress";
import { DownloadWorker } from "./download-worker";

// Keep disk capacity deterministic; publication, confinement and cleanup use real files.
const capabilities = vi.hoisted(() => ({ denyLinks: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    statfs: async () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }),
    link: async (source: string, target: string) => {
      if (capabilities.denyLinks)
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      return fs.link(source, target);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  capabilities.denyLinks = false;
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(options: { forbidDownload?: boolean; invalidMedia?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mv-worker-recovery-")));
  directories.push(root);
  const destination = join(root, "Downloads");
  const tempDirectory = join(root, "Temp");
  await mkdir(destination);
  const job: DownloadJob = {
    id: randomUUID(),
    sourceUrl: "https://example.test/video.mp4",
    title: "Movie",
    container: "mp4",
    quality: "best",
    destinationDirectory: destination,
    downloadedBytes: 0,
    progress: 0,
    status: "paused",
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
    fromAnalysis: false,
  };
  const analyzer = {
    async download(_job: DownloadJob, directory: string) {
      if (options.forbidDownload) throw new Error("unexpected download");
      const file = join(directory, "media.mp4");
      await writeFile(file, "fixture media");
      return file;
    },
  } as unknown as YtDlpService;
  const ffmpeg = {
    async probeMedia(file: string): Promise<MediaProbe> {
      if (options.invalidMedia) throw new Error("probeFailed");
      return {
        duration: 3,
        width: 320,
        height: 180,
        container: "mp4",
        fileSize: (await stat(file)).size,
        hasAudio: true,
        hasVideo: true,
      };
    },
  } as unknown as FFmpegService;
  const settings = {
    tempDirectory,
    approveDirectory: realpath,
  } as unknown as DownloadSettingsService;
  const worker = new DownloadWorker(analyzer, ffmpeg, settings);
  const progress: DownloadProgress[] = [];
  const execute = () =>
    worker.execute(job, (value) => progress.push(value), new AbortController().signal);
  return { root, destination, tempDirectory, job, worker, progress, execute };
}

describe("download worker recovery and publication", () => {
  it("rejects unsupported publication before starting a download and removes its probe", async () => {
    const f = await fixture({ forbidDownload: true });
    capabilities.denyLinks = true;
    await expect(f.execute()).rejects.toThrow("publicationUnavailable");
    expect(await readdir(f.destination)).toEqual([]);
  });
  it("reuses a same-volume output published immediately before a crash checkpoint", async () => {
    const f = await fixture();
    const work = join(f.tempDirectory, f.job.id);
    await mkdir(work, { recursive: true });
    const staged = join(work, "media.mp4"),
      output = join(f.destination, "Movie.mp4");
    await writeFile(staged, "fixture media");
    await link(staged, output);
    const result = await f.execute();
    expect(result.outputPath).toBe(output);
    expect(await readdir(f.destination)).toEqual(["Movie.mp4"]);
  });
  it("recreates a missing recorded output without overwriting another movie", async () => {
    const f = await fixture();
    f.job.outputPath = join(f.destination, "removed.mp4");
    await writeFile(join(f.destination, "Movie.mp4"), "existing user movie");
    const result = await f.execute();
    expect(result.outputPath).toBe(join(f.destination, "Movie (1).mp4"));
    expect(await readFile(result.outputPath, "utf8")).toBe("fixture media");
    expect(await readFile(join(f.destination, "Movie.mp4"), "utf8")).toBe("existing user movie");
    expect(f.progress.some((value) => value.outputPath === result.outputPath)).toBe(true);
  });

  it("reuses a valid published output without starting the downloader", async () => {
    const f = await fixture({ forbidDownload: true });
    f.job.outputPath = join(f.destination, "published.mp4");
    await writeFile(f.job.outputPath, "already published media");
    const result = await f.execute();
    expect(result.outputPath).toBe(f.job.outputPath);
    expect(result.probe.fileSize).toBe(Buffer.byteLength("already published media"));
    expect(await readdir(f.destination)).toEqual(["published.mp4"]);
    await expect(stat(f.tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects corrupt media before publication and preserves the resumable working file", async () => {
    const f = await fixture({ invalidMedia: true });
    await expect(f.execute()).rejects.toThrow(/^probeFailed$/);
    expect(await readdir(f.destination)).toEqual([]);
    expect(await readFile(join(f.tempDirectory, f.job.id, "media.mp4"), "utf8")).toBe(
      "fixture media",
    );
    expect(f.progress.every((value) => value.outputPath === undefined)).toBe(true);
  });

  it("keeps working files until completed-job cleanup and removes only that job directory", async () => {
    const f = await fixture();
    const result = await f.execute();
    const jobDirectory = join(f.tempDirectory, f.job.id);
    expect((await stat(jobDirectory)).isDirectory()).toBe(true);
    const otherDirectory = join(f.tempDirectory, randomUUID());
    await mkdir(otherDirectory);
    await writeFile(join(otherDirectory, "partial.mp4.part"), "other partial");
    await f.worker.cleanup({ ...f.job, status: "completed", outputPath: result.outputPath });
    await expect(stat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(otherDirectory, "partial.mp4.part"), "utf8")).toBe("other partial");
    expect(await readFile(result.outputPath, "utf8")).toBe("fixture media");
  });

  it("rejects an existing output outside its approved directory instead of replacing it", async () => {
    const f = await fixture({ forbidDownload: true });
    f.job.outputPath = join(f.root, "outside.mp4");
    await writeFile(f.job.outputPath, "outside movie");
    await expect(f.execute()).rejects.toThrow(/^invalidInput$/);
    expect(await readFile(f.job.outputPath, "utf8")).toBe("outside movie");
    expect(await readdir(f.destination)).toEqual([]);
  });
});
