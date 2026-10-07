import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { DownloadJob, MediaProbe } from "../../shared/models";
import type { FFmpegService } from "../services/ffmpeg-service";
import type { DownloadSettingsService } from "../services/download-settings-service";
import type { YtDlpService } from "./ytdlp-service";
import type { DownloadProgress } from "./download-progress";
import {
  assertAtomicPublication,
  assertFreeSpace,
  confinedPath,
  fileErrorCode,
  validateOwnedFile,
} from "./download-files";
import { publishRecoverably, recoverPublication, releasePublication } from "./publication";

export interface DownloadedFile {
  outputPath: string;
  modifiedAt: number;
  probe: MediaProbe;
}
export interface DownloadExecutor {
  execute(
    job: DownloadJob,
    progress: (value: DownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<DownloadedFile>;
  cleanup?(job: DownloadJob): Promise<void>;
}
export class DownloadWorker implements DownloadExecutor {
  constructor(
    private readonly analyzer: YtDlpService,
    private readonly ffmpeg: FFmpegService,
    private readonly settings: DownloadSettingsService,
  ) {}
  async execute(
    job: DownloadJob,
    progress: (value: DownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<DownloadedFile> {
    const check = () => {
      if (signal.aborted) throw new Error("cancelled");
    };
    check();
    // Persisted job destinations were approved by the native picker when queued.
    await this.settings.approveDirectory(job.destinationDirectory);
    let outputPath = job.outputPath;
    const workDirectory = confinedPath(this.settings.tempDirectory, job.id);
    if (outputPath) {
      try {
        await validateOwnedFile(job.destinationDirectory, outputPath);
      } catch (error) {
        // The user may have moved/deleted an output after pausing processing.
        // Keep any remaining partials and recreate a new, non-overwriting output.
        if (
          fileErrorCode(error) === "ENOENT" ||
          (error instanceof Error && error.message === "fileMissing")
        )
          outputPath = undefined;
        else throw error;
      }
    }
    if (!outputPath) {
      outputPath = await recoverPublication(job.destinationDirectory, job.title, workDirectory);
      if (outputPath) {
        progress({ status: "processing", outputPath });
        await releasePublication(job.destinationDirectory, workDirectory);
        check();
      }
    }
    if (!outputPath) {
      await mkdir(this.settings.tempDirectory, { recursive: true });
      await mkdir(workDirectory, { recursive: true });
      await assertAtomicPublication(job.destinationDirectory);
      await assertFreeSpace(job.destinationDirectory, job.totalBytes);
      // Temporary and destination files coexist during publication.
      await assertFreeSpace(
        workDirectory,
        job.totalBytes === undefined ? undefined : job.totalBytes * 2,
      );
      check();
      const temporaryFile = await this.analyzer.download(job, workDirectory, progress, signal);
      progress({ status: "processing", speed: 0 });
      // Reject corrupt outputs before publishing anything in the chosen folder.
      await this.ffmpeg.probeMedia(temporaryFile, signal);
      check();
      const info = await stat(temporaryFile);
      await assertFreeSpace(job.destinationDirectory, info.size);
      outputPath = await publishRecoverably(
        temporaryFile,
        job.destinationDirectory,
        job.title,
        extname(temporaryFile),
        workDirectory,
        signal,
      );
      progress({ status: "processing", outputPath });
      await releasePublication(job.destinationDirectory, workDirectory);
      check();
    }
    await validateOwnedFile(job.destinationDirectory, outputPath);
    const probe = await this.ffmpeg.probeMedia(outputPath, signal);
    check();
    return { outputPath, probe, modifiedAt: (await stat(outputPath)).mtimeMs };
  }
  async cleanup(job: DownloadJob): Promise<void> {
    // Only successful jobs reach this cleanup. Failed/paused/cancelled partials
    // remain resumable. Check the exact absolute target before recursive removal.
    if (!/^[a-f0-9-]{36}$/i.test(job.id)) return;
    const root = await realpath(this.settings.tempDirectory);
    const directory = confinedPath(root, job.id);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      return;
    await releasePublication(job.destinationDirectory, directory);
    await rm(directory, { recursive: true, force: true });
  }
}
