// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveAccount, MediaItem } from "../../shared/models";
import { SqliteDatabase } from "../database/database";
import { MediaRepository } from "../repositories/media-repository";
import { DriveUploadRepository } from "../repositories/drive-upload-repository";
import { SettingsRepository } from "../repositories/settings-repository";
import { ActivityRepository } from "../repositories/activity-repository";
import { DriveSettingsService } from "../services/drive-settings-service";
import { ActivityService } from "../services/activity-service";
import { UploadManager } from "./upload-manager";
import type { StoredDriveUpload } from "./models";
import type { UploadExecutor } from "./upload-types";

function item(id: string): MediaItem {
  return {
    id,
    title: id,
    sourceType: "local",
    localPath: join(tmpdir(), `${id}.mp4`),
    duration: 3,
    width: 320,
    height: 180,
    resolution: "320x180",
    container: "mp4",
    fileSize: 8192,
    modifiedAt: 10,
    createdAt: 1,
    updatedAt: 1,
  };
}
function remote(job: StoredDriveUpload) {
  return {
    id: job.plannedFileId ?? `remote-${job.id}`,
    name: job.fileName,
    size: job.fileSize,
    mimeType: job.mimeType,
    trashed: false,
    parents: [job.driveFolderId ?? "root-folder"],
    appProperties: { mediavault: "1", mediaId: job.mediaId, uploadId: job.id },
  };
}
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("queue condition timed out");
}

describe("durable Drive upload queue", () => {
  let directory: string, db: SqliteDatabase, media: MediaRepository, uploads: DriveUploadRepository;
  let settings: DriveSettingsService, activity: ActivityService, manager: UploadManager;
  let account: DriveAccount;
  let online = true;
  const running = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let started: string[], checkpointed: string[];
  let completed: ReturnType<
    typeof vi.fn<(job: StoredDriveUpload, item: MediaItem) => void | Promise<void>>
  >;
  let validate: ReturnType<typeof vi.fn<(id: string) => Promise<string>>>;
  let executor: UploadExecutor;
  const create = () =>
    new UploadManager({
      database: db,
      media,
      uploads,
      settings,
      activity,
      account: () => account,
      library: {
        get: (id: string) => {
          const found = media.get(id);
          if (!found) throw new Error("fileMissing");
          return found;
        },
        validateKnownFile: validate,
      },
      executor,
      isOnline: () => online,
      onLibraryChanged: vi.fn(),
      onCompleted: completed,
    });
  beforeEach(async () => {
    online = true;
    directory = await mkdtemp(join(tmpdir(), "mv-upload-manager-"));
    db = new SqliteDatabase(directory);
    media = new MediaRepository(db);
    uploads = new DriveUploadRepository(db);
    settings = new DriveSettingsService(new SettingsRepository(db));
    activity = new ActivityService(new ActivityRepository(db));
    account = {
      connected: true,
      configured: true,
      connecting: false,
      providerAccountId: "account-a",
      rootFolderId: "root-folder",
    };
    started = [];
    checkpointed = [];
    completed = vi.fn();
    running.clear();
    validate = vi.fn(async (id: string) => {
      const found = media.get(id);
      if (!found) throw new Error("fileMissing");
      return found.localPath;
    });
    executor = {
      execute: (job, checkpoint, progress, signal) =>
        new Promise((resolve, reject) => {
          started.push(job.id);
          checkpoint({ plannedFileId: `remote-${job.id}`, sessionEncrypted: "encrypted-fixture" });
          checkpointed.push(job.id);
          progress({ uploadedBytes: 1024, speed: 100, eta: 71 });
          const abort = () => reject(new Error("cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          running.set(job.id, {
            resolve: () => {
              signal.removeEventListener("abort", abort);
              resolve(remote(job));
            },
            reject: (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          });
        }),
      reconcile: async () => null,
    };
    manager = create();
  });
  afterEach(async () => {
    await manager.shutdown();
    activity.dispose();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function add(id: string) {
    media.save(item(id));
    return manager.add(id);
  }

  it("pauses offline uploads without a worker and keeps resumable checkpoints on network failure", async () => {
    online = false;
    const job = await add("offline");
    await until(() => manager.get(job.id).status === "paused");
    expect(manager.get(job.id).error).toBe("networkUnavailable");
    expect(started).toHaveLength(0);
    online = true;
    manager.resume(job.id);
    await until(() => started.length === 1);
    running.get(job.id)!.reject(new Error("networkUnavailable"));
    await until(() => manager.get(job.id).status === "paused");
    expect(uploads.get(job.id)).toMatchObject({
      error: "networkUnavailable",
      sessionEncrypted: "encrypted-fixture",
      plannedFileId: `remote-${job.id}`,
    });
    expect(started).toHaveLength(1);
  });

  it("runs two workers, persists progress, and lets queued work proceed after failure", async () => {
    const a = await add("a"),
      b = await add("b"),
      c = await add("c");
    await until(() => started.length === 2);
    expect(manager.get(c.id).status).toBe("queued");
    expect(manager.get(a.id).uploadedBytes).toBe(1024);
    running.get(a.id)!.reject(new Error("driveQuotaExceeded"));
    await until(() => started.length === 3);
    expect(manager.get(a.id)).toMatchObject({ status: "failed", error: "driveQuotaExceeded" });
    running.get(b.id)!.resolve();
    running.get(c.id)!.resolve();
    await until(() => manager.get(c.id).status === "completed");
    expect(media.get("c")).toMatchObject({
      driveAvailable: true,
      driveAccountId: "account-a",
      driveFileId: `remote-${c.id}`,
    });
    expect(uploads.get(c.id)).not.toHaveProperty("sessionEncrypted");
    expect(completed).toHaveBeenCalledTimes(2);
    expect(activity.list().some((entry) => entry.type === "driveUploadCompleted")).toBe(true);
  });

  it("deduplicates simultaneous automatic/manual enqueue and refuses already uploaded media", async () => {
    media.save(item("one"));
    const [a, b] = await Promise.all([manager.add("one"), manager.add("one")]);
    expect(a.id).toBe(b.id);
    expect(manager.list()).toHaveLength(1);
    await until(() => started.length === 1);
    running.get(a.id)!.resolve();
    await until(() => manager.get(a.id).status === "completed");
    await expect(manager.add("one")).rejects.toThrow("driveAlreadyUploaded");
    expect(manager.list()[0]).not.toHaveProperty("sessionEncrypted");
    expect(manager.list()[0]).not.toHaveProperty("plannedFileId");
  });

  it("pauses preserving session, resumes the same job and cancels without deleting local metadata", async () => {
    const job = await add("one");
    await until(() => checkpointed.length === 1);
    await manager.pause(job.id);
    expect(uploads.get(job.id)).toMatchObject({
      status: "paused",
      sessionEncrypted: "encrypted-fixture",
    });
    manager.resume(job.id);
    await until(() => started.length === 2);
    await manager.cancel(job.id);
    expect(uploads.get(job.id)).toMatchObject({
      status: "cancelled",
      plannedFileId: `remote-${job.id}`,
    });
    expect(uploads.get(job.id)).not.toHaveProperty("sessionEncrypted");
    expect(media.get("one")?.localAvailable).not.toBe(false);
    manager.retry(job.id);
    await until(() => started.length === 3);
    running.get(job.id)!.resolve();
    await until(() => manager.get(job.id).status === "completed");
    expect(manager.list()).toHaveLength(1);
  });

  it("refuses disconnected, foreign-account, unavailable and changed local records", async () => {
    media.save(item("one"));
    account.connected = false;
    await expect(manager.add("one")).rejects.toThrow("driveNotConnected");
    account.connected = true;
    media.save({
      ...item("one"),
      driveAccountId: "account-b",
      driveFileId: "foreign",
      driveAvailable: true,
    });
    await expect(manager.add("one")).rejects.toThrow("driveAccountChanged");
    media.save({ ...item("one"), localAvailable: false });
    await expect(manager.add("one")).rejects.toThrow("fileMissing");
    media.save(item("one"));
    validate.mockRejectedValueOnce(new Error("fileChanged"));
    await expect(manager.add("one")).rejects.toThrow("fileChanged");
    expect(started).toHaveLength(0);
  });

  it("rejects an enqueue whose validation finishes after shutdown or account change", async () => {
    media.save(item("one"));
    let finish!: (path: string) => void;
    validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager.add("one");
    await Promise.resolve();
    await manager.shutdown();
    finish(item("one").localPath);
    await expect(pending).rejects.toThrow("unavailable");
    expect(uploads.list()).toHaveLength(0);
  });

  it("restores interrupted work paused and never starts workers without user action", async () => {
    const job = await add("one");
    await until(() => started.length === 1);
    await manager.shutdown();
    manager = create();
    expect(manager.get(job.id).status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toHaveLength(1);
    account = { ...account, providerAccountId: "account-b" };
    expect(() => manager.resume(job.id)).toThrow("driveAccountChanged");
  });

  it("keeps remote finalization recoverable when the completion transaction fails", async () => {
    const job = await add("one");
    await until(() => started.length === 1);
    const originalSave = media.save.bind(media);
    const spy = vi.spyOn(media, "save").mockImplementation((value) => {
      if (value.driveAvailable) throw new Error("databaseFailed");
      return originalSave(value);
    });
    running.get(job.id)!.resolve();
    await until(() => manager.get(job.id).status === "finalizing");
    expect(uploads.get(job.id)?.plannedFileId).toBe(`remote-${job.id}`);
    expect(media.get("one")?.driveAvailable).not.toBe(true);
    expect(completed).not.toHaveBeenCalled();
    spy.mockRestore();
    executor.reconcile = async (stored) => remote(stored);
    await manager.reconcile();
    expect(manager.get(job.id).status).toBe("completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("marks upload completed before invoking a nonblocking post-upload decision", async () => {
    completed.mockImplementation(() => new Promise(() => {}));
    settings.update({ ...settings.get(), concurrency: 1 });
    const a = await add("one"),
      b = await add("two");
    await until(() => started.length === 1);
    running.get(a.id)!.resolve();
    await until(() => started.length === 2);
    expect(manager.get(a.id).status).toBe("completed");
    expect(manager.get(b.id).status).toBe("uploading");
  });

  it("pauses active/queued work at disconnect without starting the waiting job", async () => {
    settings.update({ ...settings.get(), concurrency: 1 });
    const a = await add("one"),
      b = await add("two");
    await until(() => started.length === 1);
    await manager.suspend();
    expect(manager.get(a.id).status).toBe("paused");
    expect(manager.get(b.id).status).toBe("paused");
    expect(started).toHaveLength(1);
    expect(manager.hasActiveWork()).toBe(false);
  });

  it("does not finalize or trigger deletion after cancellation races a reconciliation query", async () => {
    const job = await add("one");
    await until(() => started.length === 1);
    await manager.pause(job.id);
    let respond!: () => void;
    executor.reconcile = (stored) =>
      new Promise((resolve) => {
        respond = () => resolve(remote(stored));
      });
    const pending = manager.reconcile();
    await Promise.resolve();
    const cancelled = manager.cancel(job.id);
    respond();
    await Promise.all([cancelled, pending]);
    expect(manager.get(job.id).status).toBe("cancelled");
    expect(media.get("one")?.driveAvailable).not.toBe(true);
    expect(completed).not.toHaveBeenCalled();
  });

  it("rejects an enqueue crossing the disconnect pause boundary even before auth state clears", async () => {
    media.save(item("one"));
    let finish!: (path: string) => void;
    validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = manager.add("one");
    await Promise.resolve();
    await manager.suspend();
    finish(item("one").localPath);
    await expect(pending).rejects.toThrow("driveNotConnected");
    manager.enable();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uploads.list()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("blocks resume and retry while suspended even if the auth snapshot has not cleared", async () => {
    const a = await add("one"),
      b = await add("two");
    await until(() => started.length === 2);
    running.get(b.id)!.reject(new Error("driveQuotaExceeded"));
    await until(() => manager.get(b.id).status === "failed");
    await manager.suspend();
    expect(() => manager.resume(a.id)).toThrow("driveNotConnected");
    expect(() => manager.retry(b.id)).toThrow("driveNotConnected");
  });

  it("does not let shutdown or Pause All turn an in-flight cancellation into a resumable pause", async () => {
    let fail!: (error: Error) => void;
    executor.execute = (_job, checkpoint) =>
      new Promise((_resolve, reject) => {
        fail = reject;
        checkpoint({ sessionEncrypted: "cipher" });
      });
    const job = await add("one");
    await until(() => Boolean(fail));
    const cancel = manager.cancel(job.id),
      suspend = manager.suspend();
    fail(new Error("cancelled"));
    await Promise.all([cancel, suspend]);
    expect(manager.get(job.id).status).toBe("cancelled");
    expect(uploads.get(job.id)).not.toHaveProperty("sessionEncrypted");
  });
  it("keeps SQLite at the acknowledged offset when pausing after additional bytes were sent", async () => {
    media.save({ ...item("large"), fileSize: 2 * 1024 * 1024 });
    executor.execute = (_job, checkpoint, progress, signal) =>
      new Promise((_resolve, reject) => {
        checkpoint({ uploadedBytes: 512 * 1024 });
        progress({ uploadedBytes: 1024 * 1024, speed: 100 });
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    const job = await manager.add("large");
    await until(() => manager.get(job.id).status === "uploading");
    expect(manager.get(job.id)).toMatchObject({ uploadedBytes: 1024 * 1024, progress: 50 });
    expect(uploads.get(job.id)?.uploadedBytes).toBe(512 * 1024);
    await manager.pause(job.id);
    expect(uploads.get(job.id)).toMatchObject({
      uploadedBytes: 512 * 1024,
      progress: 25,
      status: "paused",
    });
    expect(manager.get(job.id)).toMatchObject({
      uploadedBytes: 512 * 1024,
      progress: 25,
      status: "paused",
    });
  });
  it("holds deletion until active work settles and rejects every restart path while locked", async () => {
    let rejectWork!: (error: Error) => void;
    let observedAbort = false;
    executor.execute = (_job, _checkpoint, _progress, signal) =>
      new Promise((_resolve, reject) => {
        rejectWork = reject;
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
          },
          { once: true },
        );
      });
    const job = await add("one");
    await until(() => Boolean(rejectWork));
    let releaseAction!: () => void;
    const action = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releaseAction = () => resolve(42);
        }),
    );
    const locked = manager.withMediaLock("one", action);
    expect(observedAbort).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await expect(manager.add("one")).rejects.toThrow("unavailable");
    await expect(manager.addAutomatic("one", "account-a")).rejects.toThrow("unavailable");
    rejectWork(new Error("cancelled"));
    await until(() => action.mock.calls.length === 1);
    expect(() => manager.retry(job.id)).toThrow("unavailable");
    expect(() => manager.resume(job.id)).toThrow("unavailable");
    const reconcile = vi.spyOn(executor, "reconcile");
    await manager.reconcile();
    expect(reconcile).not.toHaveBeenCalled();
    manager.settingsChanged();
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    releaseAction();
    expect(await locked).toBe(42);
    expect(manager.get(job.id).status).toBe("cancelled");
    await expect(
      manager.withMediaLock("one", async () => {
        throw new Error("delete failed");
      }),
    ).rejects.toThrow("delete failed");
    expect(await manager.withMediaLock("one", async () => 7)).toBe(7);
  });
  it("invalidates enqueue validation crossing a media lock even when deletion has already finished", async () => {
    media.save(item("one"));
    let release!: (path: string) => void;
    validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const enqueue = manager.add("one");
    const rejection = expect(enqueue).rejects.toThrow("unavailable");
    await manager.withMediaLock("one", async () => {});
    release(item("one").localPath);
    await rejection;
    expect(uploads.list()).toHaveLength(0);
  });
  it("waits for an in-flight reconciliation before entering a media deletion action", async () => {
    const job = await add("one");
    await until(() => started.length === 1);
    await manager.pause(job.id);
    let respond!: () => void;
    executor.reconcile = (stored) =>
      new Promise((resolve) => {
        respond = () => resolve(remote(stored));
      });
    const pending = manager.reconcile();
    await until(() => Boolean(respond));
    const action = vi.fn(async () => "deleted");
    const locked = manager.withMediaLock("one", action);
    expect(action).not.toHaveBeenCalled();
    respond();
    await pending;
    expect(await locked).toBe("deleted");
    expect(manager.get(job.id).status).toBe("cancelled");
    expect(completed).not.toHaveBeenCalled();
  });
  it("awaits a locked deletion already in progress before shutdown can close its database", async () => {
    media.save(item("one"));
    let finish!: () => void;
    let entered = false;
    const deletion = manager.withMediaLock("one", async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      media.save({ ...item("one"), localAvailable: false });
    });
    await until(() => entered);
    let stopped = false;
    const stopping = manager.shutdown().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    finish();
    await Promise.all([deletion, stopping]);
    expect(media.get("one")?.localAvailable).toBe(false);
  });
});
