// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaItem, DriveUploadStatus } from "../../shared/models";
import { uploadDTO, type StoredDriveUpload } from "../drive/models";
import { SqliteDatabase } from "../database/database";
import { DriveUploadRepository } from "./drive-upload-repository";
import { MediaRepository } from "./media-repository";
import { ActivityRepository } from "./activity-repository";

function upload(id: string, status: DriveUploadStatus = "queued"): StoredDriveUpload {
  return {
    id,
    mediaId: `media-${id}`,
    providerAccountId: "account-a",
    localPath: `C:/Videos/${id}.mp4`,
    modifiedAt: 123.25,
    fileName: "Film's title; --.mp4",
    fileSize: 50_000_000_000,
    mimeType: "video/mp4",
    uploadedBytes: 0,
    progress: 0,
    status,
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
function media(id: string): MediaItem {
  return {
    id,
    title: "Movie",
    sourceType: "local",
    localPath: `C:/Videos/${id}.mp4`,
    duration: 3,
    width: 320,
    height: 180,
    resolution: "320x180",
    container: "mp4",
    fileSize: 50_000_000_000,
    modifiedAt: 123.25,
    createdAt: 1,
    updatedAt: 1,
  };
}
describe("Drive persistence repositories", () => {
  let directory: string,
    db: SqliteDatabase,
    uploads: DriveUploadRepository,
    library: MediaRepository;
  const open = () => {
    db = new SqliteDatabase(directory);
    uploads = new DriveUploadRepository(db);
    library = new MediaRepository(db);
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-drive-db-"));
    open();
  });
  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips 50GB upload and encrypted recovery metadata across reopen, excluding private fields from DTO", () => {
    const complete = {
      ...upload("full", "finalizing"),
      driveFolderId: "folder",
      driveFileId: "remote",
      plannedFileId: "planned",
      sessionEncrypted: "encrypted-opaque-fixture",
      uploadedBytes: 50_000_000_000,
      progress: 100,
      speed: 1500,
      eta: 0,
      startedAt: 2,
      completedAt: 3,
      updatedAt: 3,
      attempts: 2,
      error: "driveVerificationFailed" as const,
    };
    uploads.save(complete);
    db.close();
    open();
    expect(uploads.get("full")).toEqual(complete);
    expect(uploads.list()).toEqual([complete]);
    expect(uploads.get("missing")).toBeUndefined();
    const dto = uploadDTO(uploads.get("full")!);
    for (const key of ["localPath", "modifiedAt", "attempts", "sessionEncrypted", "plannedFileId"])
      expect(dto).not.toHaveProperty(key);
    expect(JSON.stringify(dto)).not.toContain("encrypted-opaque-fixture");
  });

  it("clears old optional fields on upsert rather than retaining a cancelled session", () => {
    uploads.save({
      ...upload("one"),
      sessionEncrypted: "ciphertext",
      plannedFileId: "planned",
      speed: 4,
      eta: 2,
      error: "driveUploadFailed",
    });
    const cancelled = upload("one", "cancelled");
    uploads.save(cancelled);
    expect(uploads.get("one")).toEqual(cancelled);
  });

  it("enforces one resumable or failed job per media/account while allowing another account and terminal history", () => {
    for (const status of [
      "queued",
      "preparing",
      "uploading",
      "paused",
      "finalizing",
      "failed",
    ] as const) {
      const first = { ...upload(status, status), mediaId: `same-${status}` };
      uploads.save(first);
      expect(() => uploads.save({ ...first, id: `${status}-duplicate` })).toThrow(
        /^databaseFailed$/,
      );
      uploads.save({ ...first, id: `${status}-other-account`, providerAccountId: "account-b" });
      expect(uploads.findActive(first.mediaId, "account-a")?.id).toBe(status);
      uploads.save({ ...first, id: `${status}-history`, status: "completed" });
    }
    expect(uploads.findActive("absent", "account-a")).toBeUndefined();
  });

  it("recovers interrupted jobs without auto-resuming or discarding finalization identity", () => {
    for (const status of [
      "queued",
      "preparing",
      "uploading",
      "paused",
      "finalizing",
      "completed",
      "failed",
      "cancelled",
    ] as const)
      uploads.save({
        ...upload(status, status),
        sessionEncrypted: "ciphertext",
        plannedFileId: "planned",
        speed: 99,
        eta: 2,
        uploadedBytes: 123,
      });
    expect(uploads.recoverInterrupted(50)).toBe(3);
    for (const id of ["queued", "preparing", "uploading"]) {
      expect(uploads.get(id)).toMatchObject({
        status: "paused",
        uploadedBytes: 123,
        sessionEncrypted: "ciphertext",
        plannedFileId: "planned",
        updatedAt: 50,
      });
      expect(uploads.get(id)).not.toHaveProperty("speed");
      expect(uploads.get(id)).not.toHaveProperty("eta");
    }
    expect(uploads.get("finalizing")?.status).toBe("finalizing");
    expect(
      uploads
        .listRecoverable()
        .map((job) => job.id)
        .sort(),
    ).toEqual(["failed", "finalizing", "paused", "preparing", "queued", "uploading"].sort());
  });

  it("keeps upload audit history when media is removed and supports explicit history cleanup", () => {
    const item = media("local");
    library.save(item);
    uploads.save({ ...upload("complete", "completed"), mediaId: item.id });
    uploads.save({ ...upload("pending"), mediaId: item.id });
    library.remove(item.id);
    expect(uploads.list()).toHaveLength(2);
    expect(uploads.deleteCompleted()).toBe(1);
    expect(uploads.removeForMedia(item.id)).toBe(1);
    expect(uploads.list()).toEqual([]);
  });

  it("atomically rolls back completion/media/activity while retaining previously persisted finalization intent", () => {
    const item = media("atomic");
    library.save(item);
    const pending = {
      ...upload("atomic", "finalizing"),
      mediaId: item.id,
      plannedFileId: "preallocated",
    };
    uploads.save(pending);
    const activity = new ActivityRepository(db);
    expect(() =>
      db.transaction(() => {
        uploads.save({ ...pending, status: "completed", driveFileId: "preallocated" });
        library.save({
          ...item,
          driveAvailable: true,
          driveFileId: "preallocated",
          driveAccountId: pending.providerAccountId,
          driveStatus: "completed",
        });
        activity.add({
          id: "event",
          type: "driveUploadCompleted",
          title: "Movie",
          createdAt: 2,
          mediaId: item.id,
        });
        throw new Error("disk write failure");
      }),
    ).toThrow(/^databaseFailed$/);
    expect(uploads.get(pending.id)).toEqual(pending);
    expect(library.get(item.id)).toEqual(item);
    expect(activity.list()).toEqual([]);
  });

  it("preserves legacy DTO shape and round-trips explicit cloud/local availability", () => {
    const legacy = media("old");
    library.save(legacy);
    expect(library.get(legacy.id)).toEqual(legacy);
    const cloud: MediaItem = {
      ...media("cloud"),
      localAvailable: false,
      driveAvailable: true,
      driveFileId: "file",
      driveAccountId: "account",
      driveUploadedAt: 4,
      driveStatus: "completed",
    };
    library.save(cloud);
    db.close();
    open();
    expect(library.get(cloud.id)).toEqual(cloud);
  });

  it("releases an unavailable path without attaching new local bytes to the old cloud record", () => {
    const old: MediaItem = {
      ...media("old"),
      localAvailable: false,
      driveAvailable: true,
      driveFileId: "old-cloud",
      driveAccountId: "account",
      driveStatus: "completed",
    };
    library.save(old);
    expect(library.getByPath(old.localPath)).toBeUndefined();
    const replacement: MediaItem = {
      ...media("replacement"),
      localPath: old.localPath,
      fileSize: 25,
      modifiedAt: 999,
    };
    library.save(replacement);
    expect(library.getByPath(old.localPath)).toEqual(replacement);
    expect(library.get(old.id)).toEqual(old);
  });
});
