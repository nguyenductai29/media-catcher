import type { DriveAccount, DriveUpload, MediaItem } from "../../shared/models";

export const activeUploadStatuses = new Set([
  "queued",
  "preparing",
  "uploading",
  "paused",
  "finalizing",
]);
export const runningUploadStatuses = new Set(["preparing", "uploading", "finalizing"]);
export const hasLocalFile = (item: MediaItem) => item.localAvailable !== false;
export const hasDriveFile = (item: MediaItem) => item.driveAvailable === true && !!item.driveFileId;
export const otherDriveAccount = (item: MediaItem, account: DriveAccount) =>
  !!item.driveAccountId &&
  !!account.providerAccountId &&
  item.driveAccountId !== account.providerAccountId;
export const canOpenDrive = (item: MediaItem, account: DriveAccount) =>
  account.connected &&
  hasDriveFile(item) &&
  !!item.driveAccountId &&
  item.driveAccountId === account.providerAccountId;
export const latestUpload = (item: MediaItem, uploads: DriveUpload[], account: DriveAccount) =>
  uploads
    .filter((job) => job.mediaId === item.id && job.providerAccountId === account.providerAccountId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
export const canUploadMedia = (item: MediaItem, account: DriveAccount, uploads: DriveUpload[]) =>
  hasLocalFile(item) &&
  !hasDriveFile(item) &&
  !otherDriveAccount(item, account) &&
  item.driveStatus !== "changed" &&
  !uploads.some(
    (job) =>
      job.mediaId === item.id &&
      (activeUploadStatuses.has(job.status) ||
        (job.status === "failed" && job.providerAccountId === account.providerAccountId)),
  );
export const canRetryUpload = (item: MediaItem, job: DriveUpload, account: DriveAccount) =>
  account.connected &&
  job.providerAccountId === account.providerAccountId &&
  job.status === "failed" &&
  hasLocalFile(item) &&
  !hasDriveFile(item) &&
  item.driveStatus !== "changed" &&
  !otherDriveAccount(item, account);
export function mediaStorage(item: MediaItem) {
  return hasLocalFile(item)
    ? hasDriveFile(item)
      ? "localDrive"
      : "localOnly"
    : hasDriveFile(item)
      ? "driveOnly"
      : "missing";
}
