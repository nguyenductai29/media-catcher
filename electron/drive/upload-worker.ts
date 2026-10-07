import type { DriveAccount, DriveSettings, MediaItem } from "../../shared/models";
import type { GoogleDriveService, UploadSessionState } from "./google-drive-service";
import { DriveRequestError } from "./drive-transport";
import type { SecureStore } from "./secure-store";
import type { StoredDriveUpload } from "./models";
import {
  verifyUpload,
  type UploadCheckpoint,
  type UploadExecutor,
  type UploadProgress,
  type UploadRemoteFile,
} from "./upload-types";
export type { UploadExecutor } from "./upload-types";

interface Dependencies {
  drive: Pick<
    GoogleDriveService,
    | "ensureRootFolder"
    | "uniqueFileName"
    | "generateFileId"
    | "getFile"
    | "startResumable"
    | "queryResumable"
    | "uploadChunk"
  >;
  store: Pick<SecureStore, "seal" | "unseal">;
  library: { get(id: string): MediaItem; validateKnownFile(id: string): Promise<string> };
  settings: { get(): DriveSettings };
  account(): DriveAccount;
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}
export function uploadBackoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class UploadWorker implements UploadExecutor {
  constructor(private readonly deps: Dependencies) {}
  private account(job: StoredDriveUpload, signal: AbortSignal): void {
    check(signal);
    const account = this.deps.account();
    if (!account.connected || !account.providerAccountId) throw new Error("driveNotConnected");
    if (account.providerAccountId !== job.providerAccountId) throw new Error("driveAccountChanged");
  }
  private async validate(job: StoredDriveUpload, signal: AbortSignal): Promise<void> {
    this.account(job, signal);
    const item = this.deps.library.get(job.mediaId);
    if (item.localAvailable === false) throw new Error("fileMissing");
    if (
      item.localPath !== job.localPath ||
      item.fileSize !== job.fileSize ||
      item.modifiedAt !== job.modifiedAt
    )
      throw new Error("fileChanged");
    if ((await this.deps.library.validateKnownFile(job.mediaId)) !== job.localPath)
      throw new Error("fileChanged");
    this.account(job, signal);
  }
  private async delay(
    error: DriveRequestError,
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    await (this.deps.sleep ?? uploadBackoff)(
      Math.max(error.retryAfterMs ?? 0, 1000 * 2 ** attempt),
      signal,
    );
    check(signal);
  }
  private async retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      check(signal);
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof DriveRequestError) || !error.retryable || attempt >= 2) throw error;
        await this.delay(error, attempt, signal);
      }
    }
  }
  async reconcile(job: StoredDriveUpload, signal: AbortSignal): Promise<UploadRemoteFile | null> {
    this.account(job, signal);
    if (!job.plannedFileId) return null;
    const file = await this.retry(
      () => this.deps.drive.getFile(job.plannedFileId!, signal),
      signal,
    );
    this.account(job, signal);
    if (file) verifyUpload(job, file);
    return file;
  }
  async execute(
    original: StoredDriveUpload,
    checkpoint: (patch: UploadCheckpoint) => void,
    progress: (value: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<UploadRemoteFile> {
    const job = { ...original };
    const save = (patch: UploadCheckpoint) => {
      this.account(job, signal);
      // SQLite must accept each capability/identity checkpoint before its next HTTP operation.
      checkpoint(patch);
      if (patch.plannedFileId !== undefined) job.plannedFileId = patch.plannedFileId;
      if (patch.driveFolderId !== undefined) job.driveFolderId = patch.driveFolderId;
      if (patch.fileName !== undefined) job.fileName = patch.fileName;
      if (patch.uploadedBytes !== undefined) job.uploadedBytes = patch.uploadedBytes;
      if (patch.sessionEncrypted === null) delete job.sessionEncrypted;
      else if (patch.sessionEncrypted !== undefined) job.sessionEncrypted = patch.sessionEncrypted;
    };
    const existing = await this.reconcile(job, signal);
    if (existing) return existing;
    await this.validate(job, signal);
    if (!job.plannedFileId) {
      const root = await this.retry(
        () =>
          this.deps.drive.ensureRootFolder(
            job.driveFolderId ?? this.deps.account().rootFolderId,
            signal,
          ),
        signal,
      );
      const name = await this.retry(
        () => this.deps.drive.uniqueFileName(root.id, job.fileName, signal),
        signal,
      );
      const id = await this.retry(() => this.deps.drive.generateFileId(signal), signal);
      save({ driveFolderId: root.id, fileName: name, plannedFileId: id });
    }
    if (!job.driveFolderId) throw new Error("driveVerificationFailed");
    const context = `${job.providerAccountId}:${job.id}`;
    let sessionURL = job.sessionEncrypted
      ? this.deps.store.unseal(job.sessionEncrypted, context)
      : undefined;
    let state: UploadSessionState = sessionURL
      ? await this.retry(
          () => this.deps.drive.queryResumable(sessionURL!, job.fileSize, signal),
          signal,
        )
      : { kind: "expired" };
    let restarts = 0,
      failures = 0,
      stalls = 0,
      finalizationPolls = 0;
    const started = Date.now();
    let baseline = state.kind === "incomplete" ? state.uploadedBytes : 0;
    const report = (bytes: number) => {
      if (signal.aborted) return;
      const seconds = Math.max(0.05, (Date.now() - started) / 1000);
      const speed = Math.max(0, bytes - baseline) / seconds;
      progress({
        uploadedBytes: Math.min(job.fileSize, bytes),
        speed,
        ...(speed > 0 ? { eta: Math.max(0, job.fileSize - bytes) / speed } : {}),
      });
    };
    while (true) {
      this.account(job, signal);
      if (state.kind === "complete") {
        save({ uploadedBytes: job.fileSize, finalizing: true });
        const verified = await this.reconcile(job, signal);
        if (!verified) throw new Error("driveVerificationFailed");
        return verified;
      }
      if (state.kind === "expired" || !sessionURL) {
        if (++restarts > 3) throw new Error("driveUploadSessionExpired");
        if (job.sessionEncrypted) save({ sessionEncrypted: null, uploadedBytes: 0 });
        const confirmed = await this.reconcile(job, signal);
        if (confirmed) return confirmed;
        await this.validate(job, signal);
        try {
          sessionURL = await this.retry(
            () =>
              this.deps.drive.startResumable(
                {
                  fileId: job.plannedFileId!,
                  folderId: job.driveFolderId!,
                  name: job.fileName,
                  mimeType: job.mimeType,
                  fileSize: job.fileSize,
                  mediaId: job.mediaId,
                  uploadId: job.id,
                },
                signal,
              ),
            signal,
          );
        } catch (error) {
          // 409 and lost create/final responses may already refer to our exact file ID.
          const completed = await this.reconcile(job, signal).catch(() => null);
          if (completed) return completed;
          throw error;
        }
        save({ sessionEncrypted: this.deps.store.seal(sessionURL, context), uploadedBytes: 0 });
        state = { kind: "incomplete", uploadedBytes: 0 };
        baseline = 0;
      }
      const offset = state.uploadedBytes;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.fileSize)
        throw new Error("driveVerificationFailed");
      if (offset === job.fileSize) {
        // A full 308 Range acknowledges bytes, not a committed file. Poll the
        // existing session a bounded number of times; never resend these bytes.
        save({ uploadedBytes: offset, finalizing: true });
        if (finalizationPolls >= 3) throw new DriveRequestError("driveUnavailable", true);
        await this.delay(
          new DriveRequestError("driveUnavailable", true),
          finalizationPolls++,
          signal,
        );
        state = await this.retry(
          () => this.deps.drive.queryResumable(sessionURL!, job.fileSize, signal),
          signal,
        );
        continue;
      }
      save({ uploadedBytes: offset });
      report(offset);
      await this.validate(job, signal);
      try {
        const next = await this.deps.drive.uploadChunk(
          {
            sessionURL,
            filePath: job.localPath,
            fileSize: job.fileSize,
            modifiedAt: job.modifiedAt,
            offset,
            chunkSize: this.deps.settings.get().chunkSizeMiB * 1024 * 1024,
            onProgress: (sent) => report(offset + sent),
          },
          signal,
        );
        failures = 0;
        if (next.kind === "incomplete" && next.uploadedBytes <= offset) {
          if (++stalls >= 3) throw new Error("driveVerificationFailed");
        } else stalls = 0;
        state = next;
      } catch (error) {
        if (!(error instanceof DriveRequestError) || !error.retryable || failures >= 2) throw error;
        await this.delay(error, failures++, signal);
        // The server may have accepted some/all bytes despite a lost response.
        // Query its offset before constructing another disk stream.
        state = await this.retry(
          () => this.deps.drive.queryResumable(sessionURL!, job.fileSize, signal),
          signal,
        );
      }
    }
  }
}
