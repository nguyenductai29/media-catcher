import type { StoredDriveUpload } from "./models";

export interface UploadRemoteFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  trashed: boolean;
  parents: string[];
  appProperties: Record<string, string>;
}
export interface UploadProgress {
  uploadedBytes: number;
  speed: number;
  eta?: number;
}
export interface UploadCheckpoint {
  plannedFileId?: string;
  driveFolderId?: string;
  fileName?: string;
  sessionEncrypted?: string | null;
  uploadedBytes?: number;
  finalizing?: boolean;
}
export interface UploadExecutor {
  execute(
    job: StoredDriveUpload,
    checkpoint: (value: UploadCheckpoint) => void,
    progress: (value: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<UploadRemoteFile>;
  reconcile(job: StoredDriveUpload, signal: AbortSignal): Promise<UploadRemoteFile | null>;
}
export function verifyUpload(job: StoredDriveUpload, file: UploadRemoteFile): void {
  if (
    !job.plannedFileId ||
    file.id !== job.plannedFileId ||
    file.trashed ||
    file.size !== job.fileSize ||
    !job.driveFolderId ||
    !file.parents.includes(job.driveFolderId) ||
    file.appProperties["mediavault"] !== "1" ||
    file.appProperties["mediaId"] !== job.mediaId ||
    file.appProperties["uploadId"] !== job.id
  )
    throw new Error("driveVerificationFailed");
}
