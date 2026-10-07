// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase } from "../database/database";
import { DownloadRepository } from "../repositories/download-repository";
import { MediaRepository } from "../repositories/media-repository";
import { SettingsRepository } from "../repositories/settings-repository";
import { ActivityRepository } from "../repositories/activity-repository";
import { DownloadSettingsService } from "../services/download-settings-service";
import { ActivityService } from "../services/activity-service";
import { DownloadManager } from "./download-manager";
import type { DownloadedFile } from "./download-worker";
import type { DownloadJob, MediaItem } from "../../shared/models";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "mv-queue-"));
  const database = new SqliteDatabase(join(root, "data"));
  const downloads = new DownloadRepository(database),
    media = new MediaRepository(database);
  const settings = new DownloadSettingsService(new SettingsRepository(database), root);
  const activity = new ActivityService(new ActivityRepository(database));
  const completed = vi.fn<(item: MediaItem) => void | Promise<void>>();
  const running = new Map<
    string,
    {
      resolve: (value: DownloadedFile) => void;
      reject: (error: Error) => void;
      signal: AbortSignal;
    }
  >();
  const executor = {
    execute: vi.fn(
      (job: DownloadJob, _progress: unknown, signal: AbortSignal) =>
        new Promise<DownloadedFile>((resolve, reject) => {
          running.set(job.id, { resolve, reject, signal });
          signal.addEventListener(
            "abort",
            () => {
              running.delete(job.id);
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    ),
  };
  const manager = new DownloadManager({
    database,
    downloads,
    media,
    settings,
    activity,
    executor,
    prepareMedia: async (job, file) => ({
      id: `media-${job.id}`,
      downloadId: job.id,
      title: job.title,
      sourceType: "download",
      localPath: file.outputPath,
      duration: 3,
      width: 320,
      height: 180,
      resolution: "320×180",
      container: "mp4",
      fileSize: 1000,
      modifiedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
    onLibraryChanged: () => {},
    onCompleted: completed,
  });
  cleanups.push(async () => {
    await manager.shutdown();
    activity.dispose();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const add = (title = "Movie") =>
    manager.add(
      {
        mediaId: "detected",
        title,
        quality: "best",
        container: "mp4",
        destinationDirectory: settings.get().directory,
      },
      {
        id: "detected",
        url: "https://example.com/movie.mp4",
        sourcePageUrl: "https://example.com",
        type: "direct",
        origin: "network",
        detectedAt: 1,
      },
    );
  const finish = (job: DownloadJob) => {
    const worker = running.get(job.id)!;
    running.delete(job.id);
    worker.resolve({
      outputPath: join(root, `${job.id}.mp4`),
      modifiedAt: 1,
      probe: {
        fileSize: 1000,
        duration: 3,
        width: 320,
        height: 180,
        container: "mp4",
        hasAudio: true,
        hasVideo: true,
      },
    });
  };
  return {
    manager,
    add,
    finish,
    running,
    executor,
    downloads,
    media,
    settings,
    activity,
    completed,
  };
}
describe("persisted download scheduler", () => {
  it("limits concurrency and continues other jobs after failure", async () => {
    const f = await setup();
    const a = await f.add(),
      b = await f.add(),
      c = await f.add();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(2));
    expect(f.manager.list().find((x) => x.id === c.id)?.status).toBe("queued");
    f.running.get(a.id)!.reject(new Error("downloadFailed"));
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(3));
    expect(f.downloads.get(a.id)?.status).toBe("failed");
    f.finish(b);
    f.finish(c);
    await vi.waitFor(() => expect(f.media.list()).toHaveLength(2));
    expect(f.downloads.get(b.id)?.progress).toBe(100);
  });
  it("pauses/cancels the worker and resumes/retries the same persisted job", async () => {
    const f = await setup();
    const job = await f.add();
    await vi.waitFor(() => expect(f.running.has(job.id)).toBe(true));
    const signal = f.running.get(job.id)!.signal;
    await f.manager.pause(job.id);
    expect(signal.aborted).toBe(true);
    expect(f.downloads.get(job.id)?.status).toBe("paused");
    f.manager.resume(job.id);
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(2));
    await f.manager.cancel(job.id);
    expect(f.downloads.get(job.id)?.status).toBe("cancelled");
    f.manager.retry(job.id);
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(3));
    expect(f.manager.list()).toHaveLength(1);
    f.finish(job);
    await vi.waitFor(() => expect(f.downloads.get(job.id)?.status).toBe("completed"));
    expect(() => f.manager.resume(job.id)).toThrow("invalidInput");
    f.manager.clearCompleted();
    expect(f.manager.list()).toHaveLength(0);
    expect(f.media.list()).toHaveLength(1);
  });
  it("shutdown persists every active/queued job as paused without starting another", async () => {
    const f = await setup();
    await f.add();
    await f.add();
    await f.add();
    await f.manager.shutdown();
    expect(f.downloads.list().every((job) => job.status === "paused")).toBe(true);
    expect(f.running.size).toBe(0);
  });
  it("never completes or inserts media when validation fails", async () => {
    const f = await setup();
    const job = await f.add();
    await vi.waitFor(() => expect(f.running.has(job.id)).toBe(true));
    f.running.get(job.id)!.reject(new Error("probeFailed"));
    await vi.waitFor(() => expect(f.downloads.get(job.id)?.status).toBe("failed"));
    expect(f.media.list()).toEqual([]);
  });
  it("keeps automatic retry workers tracked when a simultaneous settings change pumps the queue", async () => {
    const f = await setup();
    await f.settings.update({ ...f.settings.get(), autoRetry: true });
    f.executor.execute.mockImplementationOnce(async () => {
      queueMicrotask(() => f.manager.settingsChanged());
      throw new Error("downloadFailed");
    });
    const job = await f.add();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(2));
    const signal = f.running.get(job.id)!.signal;
    await f.manager.pause(job.id);
    expect(signal.aborted).toBe(true);
    expect(f.downloads.get(job.id)?.status).toBe("paused");
    expect(f.running.size).toBe(0);
  });
  it("starts a newly added job after Pause All finishes draining existing workers", async () => {
    const f = await setup();
    let release!: () => void;
    f.executor.execute.mockImplementationOnce(
      (_job, _progress, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              release = () => reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    );
    await f.add();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(1));
    const pausing = f.manager.pauseAll();
    const next = await f.add("Added during pause");
    expect(f.manager.get(next.id).status).toBe("queued");
    release();
    await pausing;
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledTimes(2));
    expect(f.running.has(next.id)).toBe(true);
  });
  it("rejects an add that was waiting on directory validation when shutdown began", async () => {
    const f = await setup();
    let release!: (path: string) => void;
    vi.spyOn(f.settings, "validateDirectory").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.add();
    await f.manager.shutdown();
    release(f.settings.get().directory);
    await expect(pending).rejects.toThrow("unavailable");
    expect(f.downloads.list()).toHaveLength(0);
  });
  it("rolls back media and completed status together when completion persistence fails", async () => {
    const f = await setup();
    const original = f.activity.add.bind(f.activity);
    vi.spyOn(f.activity, "add").mockImplementation((type, title, refs) => {
      if (type === "downloadCompleted") throw new Error("databaseFailed");
      original(type, title, refs);
    });
    const job = await f.add();
    await vi.waitFor(() => expect(f.running.has(job.id)).toBe(true));
    f.finish(job);
    await vi.waitFor(() => expect(f.downloads.get(job.id)?.status).toBe("failed"));
    expect(f.media.list()).toEqual([]);
    expect(f.downloads.get(job.id)?.error).toBe("databaseFailed");
    expect(f.completed).not.toHaveBeenCalled();
  });
  it("runs auto-upload only after committed completion and isolates hook failures", async () => {
    const f = await setup();
    f.completed.mockImplementation((item) => {
      expect(f.media.get(item.id)).toEqual(item);
      expect(f.downloads.get(item.downloadId!)?.status).toBe("completed");
      throw new Error("driveNotConnected");
    });
    const job = await f.add();
    await vi.waitFor(() => expect(f.running.has(job.id)).toBe(true));
    f.finish(job);
    await vi.waitFor(() => expect(f.completed).toHaveBeenCalledOnce());
    expect(f.downloads.get(job.id)?.status).toBe("completed");
    expect(f.media.list()).toHaveLength(1);
  });
});
