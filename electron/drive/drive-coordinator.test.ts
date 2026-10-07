// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DriveAccount, DriveSettings, MediaItem } from "../../shared/models";
import type { StoredDriveUpload } from "./models";
import { DriveCoordinator } from "./drive-coordinator";
import { SnapshotEvents } from "../services/snapshot-events";

function fixture() {
  let account: DriveAccount = {
    connected: true,
    configured: true,
    connecting: false,
    providerAccountId: "account-a",
    email: "user@example.test",
  };
  let settings: DriveSettings = {
    concurrency: 2,
    autoUpload: false,
    deleteLocal: "never",
    chunkSizeMiB: 8,
  };
  let item = {
    id: "media-1",
    title: "Movie",
    localPath: "C:/Videos/movie.mp4",
    fileSize: 100,
    modifiedAt: 1,
    driveFileId: "remote-file",
    driveAccountId: "account-a",
    driveAvailable: true,
    driveStatus: "completed",
  } as MediaItem;
  const job: StoredDriveUpload = {
    id: "upload-1",
    mediaId: item.id,
    providerAccountId: "account-a",
    fileName: "movie.mp4",
    fileSize: 100,
    mimeType: "video/mp4",
    localPath: item.localPath,
    modifiedAt: 1,
    plannedFileId: "remote-file",
    driveFileId: "remote-file",
    driveFolderId: "root-folder",
    uploadedBytes: 100,
    progress: 100,
    status: "completed",
    attempts: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const values = new Map<string, unknown>();
  const deps = {
    auth: {
      getAccount: () => account,
      initialize: vi.fn(async () => {}),
      connect: vi.fn(async () => account),
      disconnect: vi.fn(async () => {
        account = { ...account, connected: false };
      }),
      shutdown: vi.fn(async () => {}),
      events: new SnapshotEvents(() => account),
    },
    api: {
      getQuota: vi.fn(async () => ({ storageUsed: 10, storageLimit: 1000 })),
      ensureRootFolder: vi.fn(async () => ({ id: "root-folder", name: "MediaVault" })),
      getFile: vi.fn(async () => ({
        id: "remote-file",
        name: "movie.mp4",
        mimeType: "video/mp4",
        size: 100,
        trashed: false,
        parents: ["root-folder"],
        appProperties: { mediavault: "1", mediaId: item.id, uploadId: job.id },
      })),
    },
    uploads: {
      list: () => [],
      events: new SnapshotEvents(() => []),
      enable: vi.fn(),
      settingsChanged: vi.fn(),
      suspend: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      addAutomatic: vi.fn(async () => job),
      add: vi.fn(async () => job),
      pause: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      hasActiveWork: () => false,
      withMediaLock: async <T>(_id: string, action: () => T | Promise<T>) => action(),
    },
    media: {
      list: () => [item],
      get: () => item,
      save: vi.fn((next: MediaItem) => {
        item = next;
        return item;
      }),
    },
    preferences: {
      get: () => settings,
      update: (value: DriveSettings) => {
        settings = value;
        return value;
      },
    },
    settings: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    },
    library: { get: () => item, deleteAfterUpload: vi.fn(async () => {}) },
    activity: { add: vi.fn() },
    openExternal: vi.fn(async () => {}),
    askDelete: vi.fn(async (_item: MediaItem, _signal: AbortSignal) => false),
    onLibraryChanged: vi.fn(),
  };
  const coordinator = new DriveCoordinator(
    deps as unknown as ConstructorParameters<typeof DriveCoordinator>[0],
  );
  return {
    coordinator,
    deps,
    job,
    item,
    setAccount: (value: DriveAccount) => {
      account = value;
    },
    setDelete: (policy: DriveSettings["deleteLocal"]) => {
      settings = { ...settings, deleteLocal: policy };
    },
    setAuto: () => {
      settings = { ...settings, autoUpload: true };
    },
  };
}

describe("Drive account, automation and deletion coordination", () => {
  it("clears credentials even when pausing the queue fails during disconnect", async () => {
    const f = fixture();
    f.deps.uploads.suspend.mockRejectedValueOnce(new Error("databaseFailed"));
    await expect(f.coordinator.disconnect()).rejects.toThrow("databaseFailed");
    expect(f.deps.auth.disconnect).toHaveBeenCalledOnce();
    expect(f.coordinator.getAccount().connected).toBe(false);
    await f.coordinator.shutdown();
  });
  it("rejects late mutating IPC work once shutdown begins", async () => {
    const f = fixture();
    await f.coordinator.shutdown();
    await expect(f.coordinator.disconnect()).rejects.toThrow("unavailable");
    await expect(f.coordinator.pause("upload-1")).rejects.toThrow("unavailable");
    await expect(f.coordinator.cancel("upload-1")).rejects.toThrow("unavailable");
    expect(f.deps.auth.disconnect).not.toHaveBeenCalled();
    expect(f.deps.uploads.pause).not.toHaveBeenCalled();
    expect(f.deps.uploads.cancel).not.toHaveBeenCalled();
    expect(f.deps.activity.add).not.toHaveBeenCalled();
  });
  it("cancels pending automatic deletion when the user changes the policy to Never", async () => {
    const f = fixture();
    f.setDelete("automatic");
    const file = await f.deps.api.getFile();
    let reply!: (value: typeof file) => void;
    f.deps.api.getFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const pending = f.coordinator.uploadCompleted(f.job, f.item);
    for (let n = 0; n < 10 && !reply; n++) await Promise.resolve();
    f.coordinator.updateSettings({ ...f.coordinator.getSettings(), deleteLocal: "never" });
    reply(file);
    await pending;
    expect(f.deps.library.deleteAfterUpload).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });
  it("drains a pending automatic enqueue before shutdown and emits no late failure activity", async () => {
    const f = fixture();
    f.setAuto();
    let reject!: (error: Error) => void;
    f.deps.uploads.addAutomatic.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const enqueue = f.coordinator.downloadCompleted(f.item);
    let stopped = false;
    const shutdown = f.coordinator.shutdown().then(() => {
      stopped = true;
    });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(stopped).toBe(false);
    reject(new Error("unavailable"));
    await Promise.all([enqueue, shutdown]);
    expect(f.deps.activity.add).not.toHaveBeenCalled();
  });
  it("hydrates real quota/root and syncs only known IDs for the current account", async () => {
    const f = fixture();
    await f.coordinator.initialize();
    expect(f.coordinator.getAccount()).toMatchObject({
      storageUsed: 10,
      storageLimit: 1000,
      rootFolderId: "root-folder",
    });
    expect(f.deps.api.getFile).toHaveBeenCalledWith("remote-file", expect.any(AbortSignal));
    f.setAccount({
      connected: true,
      configured: true,
      connecting: false,
      providerAccountId: "account-b",
    });
    f.deps.api.getFile.mockClear();
    await f.coordinator.sync();
    expect(f.deps.api.getFile).not.toHaveBeenCalled();
    expect(f.deps.media.get().driveAccountId).toBe("account-a");
    await f.coordinator.shutdown();
  });
  it("auto-upload is off by default and creates only ID-based jobs after committed media is supplied", async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.downloadCompleted(f.item);
    expect(f.deps.uploads.addAutomatic).not.toHaveBeenCalled();
    f.setAuto();
    await f.coordinator.downloadCompleted(f.item);
    expect(f.deps.uploads.addAutomatic).toHaveBeenCalledWith("media-1", "account-a");
    await f.coordinator.disconnect();
    await f.coordinator.downloadCompleted(f.item);
    expect(f.deps.uploads.addAutomatic).toHaveBeenCalledTimes(2);
    await f.coordinator.shutdown();
  });
  it("Never does not ask or delete after confirmed upload", async () => {
    const f = fixture();
    await f.coordinator.uploadCompleted(f.job, f.item);
    expect(f.deps.askDelete).not.toHaveBeenCalled();
    expect(f.deps.library.deleteAfterUpload).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });
  it("Automatically re-verifies Drive metadata and then delegates guarded local deletion", async () => {
    const f = fixture();
    f.setDelete("automatic");
    await f.coordinator.uploadCompleted(f.job, f.item);
    expect(f.deps.api.getFile).toHaveBeenCalledWith("remote-file", expect.any(AbortSignal));
    expect(f.deps.library.deleteAfterUpload).toHaveBeenCalledWith(
      "media-1",
      { driveFileId: "remote-file", providerAccountId: "account-a", fileSize: 100, modifiedAt: 1 },
      expect.any(AbortSignal),
    );
    await f.coordinator.shutdown();
  });
  it("does not delete when final metadata differs, even though upload progress is 100", async () => {
    const f = fixture();
    f.setDelete("automatic");
    f.deps.api.getFile.mockResolvedValue({ ...(await f.deps.api.getFile()), size: 99 });
    await f.coordinator.uploadCompleted(f.job, f.item);
    expect(f.deps.library.deleteAfterUpload).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });
  it("Ask keeps the file on decline and cannot delete after account disconnect races a decision", async () => {
    const f = fixture();
    f.setDelete("ask");
    await f.coordinator.uploadCompleted(f.job, f.item);
    expect(f.deps.askDelete).toHaveBeenCalledOnce();
    expect(f.deps.library.deleteAfterUpload).not.toHaveBeenCalled();
    let answer!: (value: boolean) => void;
    f.deps.askDelete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.coordinator.uploadCompleted(f.job, f.item);
    for (let n = 0; n < 10 && !answer; n++) await Promise.resolve();
    const disconnect = f.coordinator.disconnect();
    answer(true);
    await Promise.all([pending, disconnect]);
    expect(f.deps.library.deleteAfterUpload).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });
  it("opens a constructed official URL and rejects records belonging to another account", async () => {
    const f = fixture();
    await f.coordinator.open("media-1");
    expect(f.deps.openExternal).toHaveBeenCalledWith(
      "https://drive.google.com/file/d/remote-file/view",
    );
    f.setAccount({
      connected: true,
      configured: true,
      connecting: false,
      providerAccountId: "account-b",
    });
    await expect(f.coordinator.open("media-1")).rejects.toThrow("driveAccountChanged");
    await f.coordinator.shutdown();
  });
});
