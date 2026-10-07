import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { DriveAccount, DriveUpload, ErrorCode, MediaItem } from "../../shared/models";
import type { SqliteDatabase } from "../database/database";
import type { DriveUploadRepository } from "../repositories/drive-upload-repository";
import type { MediaRepository } from "../repositories/media-repository";
import type { DriveSettingsService } from "../services/drive-settings-service";
import type { ActivityService } from "../services/activity-service";
import { SnapshotEvents } from "../services/snapshot-events";
import { uploadDTO, type StoredDriveUpload } from "./models";
import {
  verifyUpload,
  type UploadCheckpoint,
  type UploadExecutor,
  type UploadProgress,
  type UploadRemoteFile,
} from "./upload-types";

interface Dependencies {
  database: SqliteDatabase;
  uploads: DriveUploadRepository;
  media: MediaRepository;
  settings: DriveSettingsService;
  activity: ActivityService;
  account(): DriveAccount;
  library: { get(id: string): MediaItem; validateKnownFile(id: string): Promise<string> };
  executor: UploadExecutor;
  isOnline?(): boolean;
  onLibraryChanged(): void;
  onCompleted?(job: StoredDriveUpload, item: MediaItem): void | Promise<void>;
  logError?(id: string, code: ErrorCode): void;
}
interface Active {
  controller: AbortController;
  done: Promise<void>;
  intent?: "paused" | "cancelled";
  displayProgress?: UploadProgress;
}
const working = new Set(["queued", "preparing", "uploading", "finalizing"]);
const safeErrors = new Set<ErrorCode>([
  "invalidInput",
  "unavailable",
  "cancelled",
  "databaseFailed",
  "fileMissing",
  "fileChanged",
  "fileAccessDenied",
  "driveNotConnected",
  "driveAuthFailed",
  "driveTokenExpired",
  "driveSecureStorageUnavailable",
  "drivePermissionDenied",
  "driveQuotaExceeded",
  "driveUploadFailed",
  "driveUploadSessionExpired",
  "driveFileMissing",
  "driveVerificationFailed",
  "driveAccountChanged",
  "driveAlreadyUploaded",
  "driveUnavailable",
  "networkUnavailable",
]);
export function uploadError(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message : "";
  return safeErrors.has(message as ErrorCode) ? (message as ErrorCode) : "driveUploadFailed";
}
export function mediaMime(path: string): string {
  const types: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export class UploadManager {
  private readonly jobs = new Map<string, StoredDriveUpload>();
  private readonly active = new Map<string, Active>();
  private readonly mediaLocks = new Set<string>();
  private readonly mediaEpochs = new Map<string, number>();
  private readonly mediaLockWork = new Set<Promise<unknown>>();
  private closing = false;
  private enabled = true;
  private epoch = 0;
  private holds = 0;
  private reconcileWork: Promise<void> | undefined;
  private readonly reconcileController = new AbortController();
  readonly events = new SnapshotEvents(() => this.list());
  constructor(private readonly deps: Dependencies) {
    deps.uploads.recoverInterrupted();
    for (const job of deps.uploads.list()) this.jobs.set(job.id, job);
  }
  list(): DriveUpload[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => this.snapshot(job));
  }
  get(id: string): DriveUpload {
    return this.snapshot(this.job(id));
  }
  private snapshot(job: StoredDriveUpload): DriveUpload {
    const value = uploadDTO(job),
      active = this.active.get(job.id);
    const display = active?.displayProgress;
    if (
      display &&
      !active.intent &&
      !active.controller.signal.aborted &&
      job.status === "uploading"
    ) {
      value.uploadedBytes = display.uploadedBytes;
      value.progress = Math.min(99.9, (display.uploadedBytes / job.fileSize) * 100);
      value.speed = display.speed;
      if (display.eta !== undefined) value.eta = display.eta;
      else delete value.eta;
    }
    return value;
  }
  private job(id: string): StoredDriveUpload {
    const job = this.jobs.get(id);
    if (!job) throw new Error("invalidInput");
    return job;
  }
  private account(expected?: string): string {
    if (this.closing) throw new Error("unavailable");
    const account = this.deps.account();
    if (!this.enabled || !account.connected || !account.providerAccountId)
      throw new Error("driveNotConnected");
    if (expected && account.providerAccountId !== expected) throw new Error("driveAccountChanged");
    return account.providerAccountId;
  }
  hasActiveWork(): boolean {
    return [...this.jobs.values()].some((job) => working.has(job.status));
  }
  enable(): void {
    if (!this.closing) {
      this.enabled = true;
      this.schedule();
    }
  }
  settingsChanged(): void {
    this.schedule();
  }
  private schedule(): void {
    queueMicrotask(() => this.pump());
  }
  private persist(job: StoredDriveUpload): void {
    job.updatedAt = Date.now();
    this.deps.database.transaction(() => {
      this.deps.uploads.save(job);
      const item = this.deps.media.get(job.mediaId);
      if (item && (!item.driveAccountId || item.driveAccountId === job.providerAccountId))
        this.deps.media.save({
          ...item,
          driveAccountId: job.providerAccountId,
          driveStatus: job.status,
          updatedAt: Date.now(),
        });
    });
    this.events.notify();
    this.deps.onLibraryChanged();
  }
  async add(mediaId: string): Promise<DriveUpload> {
    return this.enqueue(mediaId, this.account(), true);
  }
  /** Main-only automation: disconnected work targets the last explicit account, paused. */
  async addAutomatic(mediaId: string, accountId: string): Promise<DriveUpload> {
    const current = this.deps.account();
    return this.enqueue(
      mediaId,
      accountId,
      this.enabled && current.connected && current.providerAccountId === accountId,
    );
  }
  private async enqueue(mediaId: string, accountId: string, start: boolean): Promise<DriveUpload> {
    if (this.closing || this.mediaLocks.has(mediaId)) throw new Error("unavailable");
    const epoch = this.epoch;
    const mediaEpoch = this.mediaEpochs.get(mediaId) ?? 0;
    if (start && !this.enabled) throw new Error("driveNotConnected");
    const original = this.deps.library.get(mediaId);
    if (original.driveAccountId && original.driveAccountId !== accountId)
      throw new Error("driveAccountChanged");
    if (original.driveFileId && original.driveAvailable !== false)
      throw new Error("driveAlreadyUploaded");
    if (original.localAvailable === false) throw new Error("fileMissing");
    const path = await this.deps.library.validateKnownFile(mediaId);
    if (
      this.closing ||
      this.mediaLocks.has(mediaId) ||
      mediaEpoch !== (this.mediaEpochs.get(mediaId) ?? 0)
    )
      throw new Error("unavailable");
    if (start && (epoch !== this.epoch || !this.enabled)) throw new Error("driveNotConnected");
    if (start) this.account(accountId);
    const item = this.deps.library.get(mediaId);
    if (
      path !== item.localPath ||
      item.fileSize !== original.fileSize ||
      item.modifiedAt !== original.modifiedAt
    )
      throw new Error("fileChanged");
    if (item.driveAccountId && item.driveAccountId !== accountId)
      throw new Error("driveAccountChanged");
    if (item.driveFileId && item.driveAvailable !== false) throw new Error("driveAlreadyUploaded");
    const previous = [...this.jobs.values()].find(
      (job) =>
        job.mediaId === mediaId &&
        job.providerAccountId === accountId &&
        job.status !== "completed",
    );
    if (previous) {
      if (previous.status === "cancelled" && start) this.retry(previous.id);
      return this.snapshot(previous);
    }
    const now = Date.now(),
      folderId =
        this.deps.account().providerAccountId === accountId
          ? this.deps.account().rootFolderId
          : undefined;
    const job: StoredDriveUpload = {
      id: randomUUID(),
      mediaId,
      providerAccountId: accountId,
      localPath: path,
      modifiedAt: item.modifiedAt,
      fileName: basename(path),
      fileSize: item.fileSize,
      mimeType: mediaMime(path),
      uploadedBytes: 0,
      progress: 0,
      status: start ? "queued" : "paused",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      ...(folderId ? { driveFolderId: folderId } : {}),
    };
    this.deps.database.transaction(() => {
      this.persist(job);
      this.deps.activity.add("driveUploadQueued", item.title, { mediaId });
    });
    this.jobs.set(job.id, job);
    this.events.notify();
    this.schedule();
    return uploadDTO(job);
  }
  private pump(): void {
    const account = this.deps.account();
    if (this.closing || !this.enabled || this.holds || !account.connected) return;
    for (const job of [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (this.active.size >= this.deps.settings.get().concurrency) break;
      if (
        job.status !== "queued" ||
        this.mediaLocks.has(job.mediaId) ||
        this.active.has(job.id) ||
        job.providerAccountId !== account.providerAccountId
      )
        continue;
      const active: Active = { controller: new AbortController(), done: Promise.resolve() };
      this.active.set(job.id, active);
      active.done = this.run(job, active)
        .catch(() => {
          // The persisted preallocated ID remains the reconciliation anchor even if SQLite is temporarily unavailable.
          this.deps.logError?.(job.id, "databaseFailed");
        })
        .finally(() => {
          if (this.active.get(job.id) === active) this.active.delete(job.id);
          this.schedule();
        });
    }
  }
  private checkpoint(job: StoredDriveUpload, active: Active, patch: UploadCheckpoint): void {
    if (active.controller.signal.aborted) throw new Error("cancelled");
    this.account(job.providerAccountId);
    if (patch.plannedFileId !== undefined) job.plannedFileId = patch.plannedFileId;
    if (patch.driveFolderId !== undefined) job.driveFolderId = patch.driveFolderId;
    if (patch.fileName !== undefined) job.fileName = patch.fileName;
    if (patch.sessionEncrypted === null) delete job.sessionEncrypted;
    else if (patch.sessionEncrypted !== undefined) job.sessionEncrypted = patch.sessionEncrypted;
    if (patch.uploadedBytes !== undefined) {
      job.uploadedBytes = patch.uploadedBytes;
      delete active.displayProgress;
    }
    job.progress = Math.min(99.9, (job.uploadedBytes / job.fileSize) * 100);
    if (patch.finalizing) {
      job.status = "finalizing";
      delete active.displayProgress;
    }
    this.persist(job);
  }
  private progress(job: StoredDriveUpload, active: Active, value: UploadProgress): void {
    if (active.controller.signal.aborted || active.intent) return;
    if (
      !Number.isFinite(value.uploadedBytes) ||
      value.uploadedBytes < 0 ||
      value.uploadedBytes > job.fileSize
    )
      return;
    job.status = "uploading";
    active.displayProgress = {
      uploadedBytes: value.uploadedBytes,
      speed: Number.isFinite(value.speed) && value.speed >= 0 ? value.speed : 0,
      ...(value.eta !== undefined && Number.isFinite(value.eta) && value.eta >= 0
        ? { eta: value.eta }
        : {}),
    };
    // Streaming bytes affect snapshots only. Authoritative offsets are saved at chunk/status checkpoints.
    this.events.notify();
  }
  private async finish(
    job: StoredDriveUpload,
    file: UploadRemoteFile,
    signal: AbortSignal,
  ): Promise<void> {
    this.account(job.providerAccountId);
    verifyUpload(job, file);
    let localAvailable = true;
    try {
      await this.deps.library.validateKnownFile(job.mediaId);
    } catch (error) {
      if (uploadError(error) === "fileMissing") localAvailable = false;
      else throw error;
    }
    if (signal.aborted) throw new Error("cancelled");
    this.account(job.providerAccountId);
    const item = this.deps.library.get(job.mediaId);
    if (
      item.localPath !== job.localPath ||
      item.fileSize !== job.fileSize ||
      item.modifiedAt !== job.modifiedAt ||
      (item.driveAccountId && item.driveAccountId !== job.providerAccountId)
    )
      throw new Error("fileChanged");
    const now = Date.now();
    const completed: StoredDriveUpload = {
      ...job,
      status: "completed",
      driveFileId: file.id,
      uploadedBytes: job.fileSize,
      progress: 100,
      speed: 0,
      completedAt: now,
      updatedAt: now,
    };
    delete completed.sessionEncrypted;
    delete completed.error;
    delete completed.eta;
    const cloud: MediaItem = {
      ...item,
      localAvailable,
      driveAvailable: true,
      driveFileId: file.id,
      driveAccountId: job.providerAccountId,
      driveStatus: "completed",
      driveUploadedAt: now,
      updatedAt: now,
    };
    this.deps.database.transaction(() => {
      this.deps.uploads.save(completed);
      this.deps.media.save(cloud);
      this.deps.activity.add("driveUploadCompleted", item.title, { mediaId: item.id });
    });
    Object.assign(job, completed);
    delete job.sessionEncrypted;
    delete job.eta;
    delete job.error;
    this.events.notify();
    this.deps.onLibraryChanged();
    // Native Ask decisions never occupy an upload worker or change a committed completion to failure.
    void Promise.resolve()
      .then(() => this.deps.onCompleted?.({ ...job }, cloud))
      .catch((error: unknown) => this.deps.logError?.(job.id, uploadError(error)));
  }
  private async run(job: StoredDriveUpload, active: Active): Promise<void> {
    let remoteComplete = false;
    try {
      this.account(job.providerAccountId);
      if (this.deps.isOnline?.() === false) throw new Error("networkUnavailable");
      job.status = "preparing";
      job.startedAt ??= Date.now();
      job.attempts++;
      job.speed = 0;
      delete job.error;
      delete job.eta;
      this.persist(job);
      this.deps.activity.add("driveUploadStarted", job.fileName, { mediaId: job.mediaId });
      const file = await this.deps.executor.execute(
        { ...job },
        (patch) => this.checkpoint(job, active, patch),
        (progress) => this.progress(job, active, progress),
        active.controller.signal,
      );
      if (active.intent) throw new Error("cancelled");
      verifyUpload(job, file);
      remoteComplete = true;
      job.status = "finalizing";
      this.persist(job);
      await this.finish(job, file, active.controller.signal);
    } catch (error) {
      job.speed = 0;
      delete job.eta;
      if (active.intent) {
        job.status = active.intent;
        delete job.error;
        if (active.intent === "cancelled") delete job.sessionEncrypted;
      } else {
        job.error = uploadError(error);
        job.status = remoteComplete
          ? "finalizing"
          : job.error === "networkUnavailable"
            ? "paused"
            : "failed";
        this.deps.logError?.(job.id, job.error);
      }
      this.persist(job);
      this.deps.activity.add(
        job.status === "paused"
          ? "driveUploadPaused"
          : job.status === "cancelled"
            ? "driveUploadCancelled"
            : "driveUploadFailed",
        job.fileName,
        { mediaId: job.mediaId, ...(job.error ? { error: job.error } : {}) },
      );
    }
  }
  private async stop(id: string, intent: "paused" | "cancelled"): Promise<void> {
    const job = this.job(id),
      active = this.active.get(id);
    if (job.status === "completed") throw new Error("invalidInput");
    if (active) {
      if (active.intent !== "cancelled") active.intent = intent;
      active.controller.abort();
      await active.done;
      return;
    }
    job.status = intent;
    job.speed = 0;
    delete job.eta;
    delete job.error;
    if (intent === "cancelled") delete job.sessionEncrypted;
    this.persist(job);
    this.deps.activity.add(
      intent === "paused" ? "driveUploadPaused" : "driveUploadCancelled",
      job.fileName,
      { mediaId: job.mediaId },
    );
  }
  pause(id: string): Promise<void> {
    return this.stop(id, "paused");
  }
  cancel(id: string): Promise<void> {
    return this.stop(id, "cancelled");
  }
  resume(id: string): void {
    const job = this.job(id);
    if (this.mediaLocks.has(job.mediaId)) throw new Error("unavailable");
    this.account(job.providerAccountId);
    if (!["paused", "finalizing"].includes(job.status)) throw new Error("invalidInput");
    job.status = "queued";
    delete job.error;
    this.persist(job);
    this.deps.activity.add("driveUploadResumed", job.fileName, { mediaId: job.mediaId });
    this.schedule();
  }
  retry(id: string): void {
    const job = this.job(id);
    if (this.mediaLocks.has(job.mediaId)) throw new Error("unavailable");
    this.account(job.providerAccountId);
    if (!["failed", "cancelled"].includes(job.status)) throw new Error("invalidInput");
    job.status = "queued";
    job.attempts = 0;
    delete job.error;
    this.persist(job);
    this.deps.activity.add("driveUploadQueued", job.fileName, { mediaId: job.mediaId });
    this.schedule();
  }
  async pauseAll(): Promise<void> {
    this.holds++;
    try {
      const results = await Promise.allSettled(
        [...this.jobs.values()]
          .filter((job) => working.has(job.status) || this.active.has(job.id))
          .map((job) => this.pause(job.id)),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    } finally {
      this.holds--;
      this.schedule();
    }
  }
  async suspend(): Promise<void> {
    this.epoch++;
    this.enabled = false;
    await this.pauseAll();
  }
  async cancelForMedia(id: string): Promise<void> {
    await Promise.all(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.mediaId === id &&
            job.status !== "completed" &&
            (job.status !== "cancelled" || this.active.has(job.id)),
        )
        .map((job) => this.cancel(job.id)),
    );
  }
  /** Holds new work and waits for disk/network users before deleting a media file. */
  async withMediaLock<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    if (this.closing || this.mediaLocks.has(id)) throw new Error("unavailable");
    this.mediaLocks.add(id);
    this.mediaEpochs.set(id, (this.mediaEpochs.get(id) ?? 0) + 1);
    const work = (async () => {
      try {
        await this.cancelForMedia(id);
        if (this.closing) throw new Error("unavailable");
        return await action();
      } finally {
        this.mediaLocks.delete(id);
        this.schedule();
      }
    })();
    this.mediaLockWork.add(work);
    try {
      return await work;
    } finally {
      this.mediaLockWork.delete(work);
    }
  }
  reconcile(): Promise<void> {
    if (this.reconcileWork) return this.reconcileWork;
    this.reconcileWork = (async () => {
      const id = this.account();
      for (const job of this.jobs.values()) {
        if (this.closing || !this.enabled || this.reconcileController.signal.aborted) break;
        if (
          job.providerAccountId !== id ||
          this.mediaLocks.has(job.mediaId) ||
          !job.plannedFileId ||
          !["paused", "finalizing", "failed"].includes(job.status) ||
          this.active.has(job.id)
        )
          continue;
        const active: Active = { controller: new AbortController(), done: Promise.resolve() };
        this.active.set(job.id, active);
        const signal = AbortSignal.any([active.controller.signal, this.reconcileController.signal]);
        active.done = (async () => {
          try {
            const file = await this.deps.executor.reconcile({ ...job }, signal);
            if (signal.aborted) throw new Error("cancelled");
            if (file) await this.finish(job, file, signal);
            else if (job.status === "finalizing") {
              job.status = "paused";
              this.persist(job);
            }
          } catch (error) {
            if (active.intent) {
              job.status = active.intent;
              delete job.error;
              job.speed = 0;
              delete job.eta;
              if (active.intent === "cancelled") delete job.sessionEncrypted;
            } else {
              job.error = uploadError(error);
              this.deps.logError?.(job.id, job.error);
            }
            this.persist(job);
          }
        })().finally(() => {
          if (this.active.get(job.id) === active) this.active.delete(job.id);
          this.schedule();
        });
        await active.done;
      }
    })().finally(() => {
      this.reconcileWork = undefined;
    });
    return this.reconcileWork;
  }
  private shutdownWork: Promise<void> | undefined;
  shutdown(): Promise<void> {
    return (this.shutdownWork ??= this.drain().catch((error: unknown) => {
      this.shutdownWork = undefined;
      throw error;
    }));
  }
  private async drain(): Promise<void> {
    this.closing = true;
    this.reconcileController.abort();
    await this.suspend();
    await this.reconcileWork?.catch(() => {});
    await Promise.allSettled([...this.mediaLockWork]);
    this.events.dispose();
  }
}
