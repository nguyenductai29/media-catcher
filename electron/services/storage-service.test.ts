// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadJob, MediaItem } from "../../shared/models";
import { SqliteDatabase } from "../database/database";
import { SettingsRepository } from "../repositories/settings-repository";
import { DownloadSettingsService } from "./download-settings-service";
import { StorageService } from "./storage-service";

describe("owned storage accounting and cleanup", () => {
  let root: string, userDataDirectory: string, database: SqliteDatabase;
  let repository: SettingsRepository, settings: DownloadSettingsService, service: StorageService;
  let jobs: DownloadJob[], items: MediaItem[];
  const old = new Date(Date.now() - 10 * 86400_000);
  function dependencies() {
    return {
      userDataDirectory,
      repository,
      settings,
      downloads: { list: () => jobs },
      media: { list: () => items },
    };
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mv-storage-"));
    userDataDirectory = join(root, "profile");
    database = new SqliteDatabase(userDataDirectory);
    repository = new SettingsRepository(database);
    settings = new DownloadSettingsService(repository, join(root, "Videos"));
    jobs = [];
    items = [];
    service = new StorageService(dependencies());
  });
  afterEach(async () => {
    await service.shutdown();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  async function file(path: string, content: string, stale = false) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    if (stale) {
      await utimes(path, old, old);
      await utimes(dirname(path), old, old);
    }
    return path;
  }
  function job(id: string, status: DownloadJob["status"]): DownloadJob {
    return {
      id,
      status,
      sourceUrl: "https://example.test/file",
      title: "Fixture",
      quality: "best",
      container: "mp4",
      destinationDirectory: settings.get().directory,
      downloadedBytes: 2,
      progress: 2,
      createdAt: 1,
      updatedAt: 1,
      attempts: 1,
      fromAnalysis: false,
    };
  }
  function media(localPath: string, thumbnailPath?: string): MediaItem {
    return {
      id: randomUUID(),
      title: "Fixture",
      sourceType: "local",
      localPath,
      duration: 1,
      width: 1,
      height: 1,
      resolution: "1x1",
      container: "mp4",
      fileSize: 1,
      modifiedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      ...(thumbnailPath ? { thumbnailPath } : {}),
    };
  }
  it("reports real category bytes without following directory links or counting arbitrary profile files", async () => {
    await file(join(settings.get().directory, "movie.mp4"), "movie");
    await file(join(settings.tempDirectory, randomUUID(), "media.part"), "part");
    await file(join(settings.thumbnailDirectory, `${randomUUID()}.jpg`), "image");
    await file(join(userDataDirectory, "logs", "mediavault.log"), "log");
    const outside = join(root, "unrelated");
    await file(join(outside, "secret"), "not counted");
    await symlink(outside, join(settings.tempDirectory, "redirect"), "junction");
    const value = await service.get();
    expect(value).toMatchObject({
      downloads: 5,
      temp: 4,
      thumbnails: 5,
      logs: 3,
      fingerprintEnabled: false,
    });
    let bytes = 0;
    for (const name of ["mediavault.db", "mediavault.db-wal", "mediavault.db-shm"])
      bytes += (await stat(join(userDataDirectory, name)).catch(() => undefined))?.size ?? 0;
    expect(value.database).toBe(bytes);
  });
  it("removes only stale orphan staging while preserving every persisted retryable job and fresh work", async () => {
    const orphan = await file(
      join(settings.tempDirectory, randomUUID(), "media.mp4.part"),
      "orphan",
      true,
    );
    const preserved: string[] = [];
    for (const status of [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "paused",
      "failed",
      "cancelled",
      "completed",
    ] as const) {
      const id = randomUUID();
      jobs.push(job(id, status));
      preserved.push(await file(join(settings.tempDirectory, id, "media.mp4.part"), status, true));
    }
    const fresh = await file(join(settings.tempDirectory, randomUUID(), "media.part"), "fresh");
    const unknown = await file(
      join(settings.tempDirectory, "personal-folder", "movie.mp4"),
      "personal",
      true,
    );
    await service.startupCleanup();
    await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [...preserved, fresh, unknown])
      expect((await readFile(path)).length).toBeGreaterThan(0);
  });
  it("never deletes library files, persisted output files, or a native-picked download destination inside Temp", async () => {
    const libraryFile = await file(
      join(settings.tempDirectory, randomUUID(), "movie.mp4"),
      "library",
      true,
    );
    items.push(media(libraryFile));
    const output = await file(
      join(settings.tempDirectory, randomUUID(), "movie.mp4"),
      "download",
      true,
    );
    jobs.push({ ...job(randomUUID(), "completed"), outputPath: output });
    const selected = join(settings.tempDirectory, randomUUID());
    const selectedFile = await file(join(selected, "movie.mp4"), "selected", true);
    await settings.approveDirectory(selected);
    await settings.update({ ...settings.get(), directory: selected });
    await service.clean("staleTemp");
    for (const path of [libraryFile, output, selectedFile])
      expect((await readFile(path)).length).toBeGreaterThan(0);
  });
  it("does not follow links at the managed root or inside an orphan folder", async () => {
    const outside = join(root, "external");
    const target = await file(join(outside, "keep.part"), "external", true);
    await mkdir(settings.tempDirectory, { recursive: true });
    const linked = join(settings.tempDirectory, randomUUID());
    await symlink(outside, linked, "junction");
    await service.clean("staleTemp");
    expect(await readFile(target, "utf8")).toBe("external");
    await rm(settings.tempDirectory, { recursive: true });
    await symlink(outside, settings.tempDirectory, "junction");
    await service.clean("staleTemp");
    expect(await readFile(target, "utf8")).toBe("external");
  });
  it("deletes only old unreferenced owned thumbnails and retains fresh or foreign images", async () => {
    const used = await file(join(settings.thumbnailDirectory, `${randomUUID()}.jpg`), "used", true);
    items.push(media(join(root, "movie.mp4"), used));
    const unused = await file(
      join(settings.thumbnailDirectory, `${randomUUID()}.jpg`),
      "unused",
      true,
    );
    const fresh = await file(join(settings.thumbnailDirectory, `${randomUUID()}.jpg`), "in flight");
    const foreign = await file(join(settings.thumbnailDirectory, "family.jpg"), "personal", true);
    await service.clean("unusedThumbnails");
    await expect(readFile(unused)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [used, fresh, foreign])
      expect((await readFile(path)).length).toBeGreaterThan(0);
  });
  it("keeps the active and recent log while deleting only old app rotations", async () => {
    const directory = join(userDataDirectory, "logs");
    const active = await file(join(directory, "mediavault.log"), "active", true);
    const stale = await file(join(directory, "mediavault.log.2"), "old", true);
    const recent = await file(join(directory, "mediavault.log.1"), "recent");
    const foreign = await file(join(directory, "personal.log.1"), "personal", true);
    await service.clean("oldLogs");
    await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [active, recent, foreign])
      expect((await readFile(path)).length).toBeGreaterThan(0);
  });
  it("validates public controls and persists only an explicit boolean fingerprint preference", async () => {
    expect(service.fingerprintEnabled()).toBe(false);
    for (const value of ["true", 1, null, {}])
      await expect(service.setFingerprintEnabled(value)).rejects.toThrow("invalidInput");
    for (const value of ["../", { path: root }, "downloads", null])
      await expect(service.clean(value)).rejects.toThrow("invalidInput");
    expect((await service.setFingerprintEnabled(true)).fingerprintEnabled).toBe(true);
    await service.shutdown();
    service = new StorageService(dependencies());
    expect(service.fingerprintEnabled()).toBe(true);
    expect(repository.get("storage")).toEqual({ fingerprintEnabled: true });
  });
  it("drains queued work on shutdown and rejects later calls without touching files", async () => {
    const path = await file(join(settings.tempDirectory, randomUUID(), "media.part"), "keep", true);
    const pending = service.clean("staleTemp");
    const outcome = pending.catch((error: Error) => error.message);
    await service.shutdown();
    await outcome;
    await expect(service.get()).rejects.toThrow("unavailable");
    await expect(service.clean("staleTemp")).rejects.toThrow("unavailable");
    expect(await readFile(path, "utf8")).toBe("keep");
  });
  it("rechecks newly persisted jobs before deleting a scanned orphan", async () => {
    const id = randomUUID();
    const path = await file(join(settings.tempDirectory, id, "media.part"), "new job", true);
    await service.shutdown();
    let reads = 0;
    service = new StorageService({
      ...dependencies(),
      downloads: { list: () => (++reads === 1 ? [] : [job(id, "paused")]) },
    });
    await service.clean("staleTemp");
    expect(await readFile(path, "utf8")).toBe("new job");
  });
  it("preserves an old staging directory containing fresh work or a nested junction", async () => {
    const active = join(settings.tempDirectory, randomUUID());
    const fresh = await file(join(active, "media.part"), "fresh");
    await utimes(active, old, old);
    const linked = join(settings.tempDirectory, randomUUID());
    const oldFile = await file(join(linked, "old.part"), "old", true);
    const outside = join(root, "outside");
    const externalFile = await file(join(outside, "keep.part"), "outside", true);
    await symlink(outside, join(linked, "nested"), "junction");
    await utimes(linked, old, old);
    await service.clean("staleTemp");
    for (const path of [fresh, oldFile, externalFile])
      expect((await readFile(path)).length).toBeGreaterThan(0);
  });
});
