import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AddDownloadInput,
  DetectedMedia,
  DownloadJob,
  ErrorCode,
  MediaItem,
} from "../../shared/models";
import type { SqliteDatabase } from "../database/database";
import type { DownloadRepository } from "../repositories/download-repository";
import type { MediaRepository } from "../repositories/media-repository";
import {
  containerSchema,
  qualitySchema,
  type DownloadSettingsService,
} from "../services/download-settings-service";
import type { ActivityService } from "../services/activity-service";
import { SnapshotEvents } from "../services/snapshot-events";
import type { DownloadedFile, DownloadExecutor } from "./download-worker";
import type { DownloadProgress } from "./download-progress";
import { validDownloadUrl } from "./download-progress";

const inputSchema = z
  .object({
    mediaId: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(1024),
    quality: qualitySchema,
    container: containerSchema,
    destinationDirectory: z.string().min(1).max(2048),
  })
  .strict();
const activeStatuses = new Set(["analyzing", "downloading", "processing"]);
interface Dependencies {
  database: SqliteDatabase;
  downloads: DownloadRepository;
  media: MediaRepository;
  settings: DownloadSettingsService;
  activity: ActivityService;
  executor: DownloadExecutor;
  prepareMedia(job: DownloadJob, file: DownloadedFile, signal: AbortSignal): Promise<MediaItem>;
  onLibraryChanged(): void;
  logError?(jobId: string, code: ErrorCode): void;
}
interface Active {
  controller: AbortController;
  intent?: "paused" | "cancelled";
  done: Promise<void>;
}
const safeErrors: ErrorCode[] = [
  "binaryMissing",
  "binaryInvalid",
  "drmProtected",
  "cancelled",
  "downloadFailed",
  "probeFailed",
  "insufficientSpace",
  "fileMissing",
  "fileChanged",
  "fileAccessDenied",
  "invalidInput",
  "invalidUrl",
  "databaseFailed",
  "unsupportedFormat",
];
export class DownloadManager {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly active = new Map<string, Active>();
  private readonly dirty = new Set<string>();
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private queueHolds = 0;
  readonly events = new SnapshotEvents(() => this.list());
  constructor(private readonly deps: Dependencies) {
    deps.downloads.recoverInterrupted();
    for (const job of deps.downloads.list()) this.jobs.set(job.id, job);
  }
  list(): DownloadJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => ({ ...job }));
  }
  get(id: string): DownloadJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("invalidInput");
    return { ...job };
  }
  hasActiveWork(): boolean {
    return [...this.jobs.values()].some(
      (job) => job.status === "queued" || activeStatuses.has(job.status),
    );
  }
  private save(job: DownloadJob): void {
    job.updatedAt = Date.now();
    this.deps.downloads.save(job);
    this.dirty.delete(job.id);
    this.events.notify();
  }
  private job(id: string): DownloadJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("invalidInput");
    return job;
  }
  async add(input: AddDownloadInput, candidate: DetectedMedia): Promise<DownloadJob> {
    if (this.closing) throw new Error("unavailable");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || candidate.id !== parsed.data.mediaId) throw new Error("invalidInput");
    const sourceUrl = candidate.origin === "analysis" ? candidate.sourcePageUrl : candidate.url;
    if (!validDownloadUrl(sourceUrl)) throw new Error("invalidUrl");
    if (
      parsed.data.quality === "selected" &&
      candidate.origin === "analysis" &&
      (!candidate.formatId || !/^[a-z0-9_.-]{1,200}$/i.test(candidate.formatId))
    )
      throw new Error("invalidInput");
    const directory = await this.deps.settings.validateDirectory(parsed.data.destinationDirectory);
    if (this.closing) throw new Error("unavailable");
    const now = Date.now();
    const job: DownloadJob = {
      id: randomUUID(),
      sourceUrl,
      pageUrl: candidate.sourcePageUrl,
      title: parsed.data.title,
      quality: parsed.data.quality,
      container: parsed.data.container,
      destinationDirectory: directory,
      downloadedBytes: 0,
      progress: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      fromAnalysis: candidate.origin === "analysis",
      ...(candidate.formatId
        ? { formatId: candidate.formatId, formatLabel: candidate.formatId }
        : {}),
      ...(candidate.resolution ? { resolution: candidate.resolution } : {}),
      ...(candidate.estimatedSize && Number.isFinite(candidate.estimatedSize)
        ? { totalBytes: Math.floor(candidate.estimatedSize) }
        : {}),
    };
    this.deps.database.transaction(() => {
      this.deps.downloads.save(job);
      this.deps.activity.add("downloadQueued", job.title, { downloadId: job.id });
    });
    this.jobs.set(job.id, job);
    this.events.notify();
    this.schedule();
    return { ...job };
  }
  private schedule(): void {
    queueMicrotask(() => this.pump());
  }
  settingsChanged(): void {
    this.schedule();
  }
  private pump(): void {
    if (this.closing || this.queueHolds > 0) return;
    const waiting = [...this.jobs.values()]
      .filter((job) => job.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of waiting) {
      if (this.active.size >= this.deps.settings.get().concurrency) break;
      if (this.active.has(job.id)) continue;
      const active: Active = { controller: new AbortController(), done: Promise.resolve() };
      this.active.set(job.id, active);
      active.done = this.run(job, active)
        .catch(() => {
          /* Repository errors are represented on the job when storage remains available. */
        })
        .finally(() => {
          if (this.active.get(job.id) === active) this.active.delete(job.id);
          this.schedule();
        });
    }
  }
  private progress(job: DownloadJob, active: Active, value: DownloadProgress): void {
    if (active.intent || active.controller.signal.aborted) {
      // A cross-volume copy can finish during cancellation. Remember this owned
      // output for resume/retry without publishing a completed/library event.
      if (value.outputPath) {
        job.outputPath = value.outputPath;
        this.save(job);
      }
      return;
    }
    const statusChanged = job.status !== value.status;
    Object.assign(job, value);
    if (value.status === "processing") {
      job.speed = 0;
      delete job.eta;
    }
    this.dirty.add(job.id);
    if (statusChanged || value.outputPath) this.save(job);
    if (!this.progressTimer) this.progressTimer = setTimeout(() => this.flush(), 200);
    this.events.notify();
  }
  private flush(): void {
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    for (const id of this.dirty) {
      const job = this.jobs.get(id);
      if (job) this.save(job);
    }
    this.dirty.clear();
  }
  private async run(job: DownloadJob, active: Active): Promise<void> {
    try {
      job.status = "analyzing";
      job.startedAt ??= Date.now();
      job.attempts++;
      delete job.error;
      delete job.eta;
      job.speed = 0;
      this.save(job);
      this.deps.activity.add("downloadStarted", job.title, { downloadId: job.id });
      const file = await this.deps.executor.execute(
        { ...job },
        (value) => this.progress(job, active, value),
        active.controller.signal,
      );
      if (active.intent) throw new Error("cancelled");
      const media = await this.deps.prepareMedia({ ...job }, file, active.controller.signal);
      if (active.intent) throw new Error("cancelled");
      const completed: DownloadJob = {
        ...job,
        outputPath: file.outputPath,
        mediaId: media.id,
        status: "completed",
        progress: 100,
        downloadedBytes: file.probe.fileSize,
        totalBytes: file.probe.fileSize,
        speed: 0,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
      delete completed.eta;
      delete completed.error;
      this.deps.database.transaction(() => {
        this.deps.media.save(media);
        this.deps.downloads.save(completed);
        this.deps.activity.add("downloadCompleted", job.title, {
          downloadId: job.id,
          mediaId: media.id,
        });
        this.deps.activity.add("mediaAdded", job.title, { mediaId: media.id });
      });
      Object.assign(job, completed);
      delete job.eta;
      delete job.error;
      this.dirty.delete(job.id);
      this.events.notify();
      this.deps.onLibraryChanged();
      await this.deps.executor.cleanup?.({ ...job }).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "downloadFailed";
      const code: ErrorCode = safeErrors.includes(message as ErrorCode)
        ? (message as ErrorCode)
        : "downloadFailed";
      if (!active.intent) this.deps.logError?.(job.id, code);
      job.speed = 0;
      delete job.eta;
      if (active.intent) {
        job.status = active.intent;
        delete job.error;
      } else {
        job.status = "failed";
        job.error = code;
      }
      this.save(job);
      this.deps.activity.add(
        job.status === "paused"
          ? "downloadPaused"
          : job.status === "cancelled"
            ? "downloadCancelled"
            : "downloadFailed",
        job.title,
        { downloadId: job.id, ...(job.error ? { error: job.error } : {}) },
      );
      // One automatic retry for transient download failures; never loop on disk,
      // DRM, missing binaries or corrupt output. Manual Retry resets this budget.
      if (
        !active.intent &&
        code === "downloadFailed" &&
        this.deps.settings.get().autoRetry &&
        job.attempts < 2 &&
        !this.closing
      ) {
        job.status = "queued";
        this.save(job);
      }
    }
  }
  private async stop(id: string, intent: "paused" | "cancelled"): Promise<void> {
    const job = this.job(id),
      active = this.active.get(id);
    if (active) {
      active.intent = intent;
      active.controller.abort();
      await active.done;
      return;
    }
    if (intent === "paused" && job.status !== "queued" && job.status !== "paused")
      throw new Error("invalidInput");
    if (intent === "cancelled" && !["queued", "paused", "failed", "cancelled"].includes(job.status))
      throw new Error("invalidInput");
    job.status = intent;
    job.speed = 0;
    delete job.eta;
    delete job.error;
    this.save(job);
    this.deps.activity.add(
      intent === "paused" ? "downloadPaused" : "downloadCancelled",
      job.title,
      { downloadId: job.id },
    );
  }
  pause(id: string): Promise<void> {
    return this.stop(id, "paused");
  }
  cancel(id: string): Promise<void> {
    return this.stop(id, "cancelled");
  }
  resume(id: string): void {
    if (this.closing) throw new Error("unavailable");
    const job = this.job(id);
    if (job.status !== "paused") throw new Error("invalidInput");
    job.status = "queued";
    delete job.error;
    this.save(job);
    this.deps.activity.add("downloadResumed", job.title, { downloadId: job.id });
    this.schedule();
  }
  retry(id: string): void {
    if (this.closing) throw new Error("unavailable");
    const job = this.job(id);
    if (!["failed", "cancelled"].includes(job.status)) throw new Error("invalidInput");
    job.status = "queued";
    job.attempts = 0;
    delete job.error;
    this.save(job);
    this.deps.activity.add("downloadQueued", job.title, { downloadId: job.id });
    this.schedule();
  }
  async pauseAll(): Promise<void> {
    this.queueHolds++;
    try {
      await Promise.all(
        [...this.jobs.values()]
          .filter((job) => job.status === "queued" || activeStatuses.has(job.status))
          .map((job) => this.pause(job.id)),
      );
    } finally {
      this.queueHolds--;
      this.schedule();
    }
  }
  resumeAll(): void {
    for (const job of this.jobs.values()) if (job.status === "paused") this.resume(job.id);
  }
  clearCompleted(): void {
    this.deps.downloads.deleteCompleted();
    for (const job of this.jobs.values()) if (job.status === "completed") this.jobs.delete(job.id);
    this.events.notify();
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.pauseAll();
    this.flush();
    this.events.dispose();
  }
}
