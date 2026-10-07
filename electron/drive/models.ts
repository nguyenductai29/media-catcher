import type { DriveUpload } from "../../shared/models";

/** Main/database only. Never serialize this type across the preload bridge. */
export interface StoredDriveUpload extends DriveUpload {
  localPath: string;
  modifiedAt: number;
  attempts: number;
  sessionEncrypted?: string;
  /** Preallocated Google file ID persisted BEFORE session creation/upload. */
  plannedFileId?: string;
}

/** Explicit allowlist prevents future internal fields leaking through IPC. */
export function uploadDTO(job: StoredDriveUpload): DriveUpload {
  return {
    id: job.id,
    mediaId: job.mediaId,
    providerAccountId: job.providerAccountId,
    fileName: job.fileName,
    fileSize: job.fileSize,
    mimeType: job.mimeType,
    uploadedBytes: job.uploadedBytes,
    progress: job.progress,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.driveFolderId ? { driveFolderId: job.driveFolderId } : {}),
    ...(job.driveFileId ? { driveFileId: job.driveFileId } : {}),
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
    ...(job.speed !== undefined ? { speed: job.speed } : {}),
    ...(job.eta !== undefined ? { eta: job.eta } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}
