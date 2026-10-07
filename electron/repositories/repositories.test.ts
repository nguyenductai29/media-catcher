// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActivityItem,
  DownloadJob,
  DownloadSettings,
  DownloadStatus,
  MediaItem,
} from "../../shared/models";
import { SqliteDatabase } from "../database/database";
import { ActivityRepository } from "./activity-repository";
import { DownloadRepository } from "./download-repository";
import { MediaRepository } from "./media-repository";
import { SettingsRepository } from "./settings-repository";

function job(id: string, status: DownloadStatus = "queued"): DownloadJob {
  return {
    id,
    sourceUrl: "https://example.test/clip.mp4?signature=private",
    title: "Movie's title; DROP TABLE media; --",
    container: "original",
    quality: "best",
    destinationDirectory: "C:/Videos/Downloads",
    downloadedBytes: 0,
    progress: 0,
    status,
    createdAt: 10,
    updatedAt: 10,
    attempts: 0,
    fromAnalysis: false,
  };
}
function media(id: string, localPath = `C:/Videos/${id}.mp4`): MediaItem {
  return {
    id,
    title: "My movie",
    sourceType: "local",
    localPath,
    duration: 60,
    width: 1920,
    height: 1080,
    resolution: "1920×1080",
    container: "mp4",
    fileSize: 10_000_000_000,
    modifiedAt: 5,
    createdAt: 10,
    updatedAt: 10,
  };
}

describe("SQLite repositories", () => {
  let directory: string;
  let database: SqliteDatabase;
  let downloads: DownloadRepository;
  let library: MediaRepository;
  let activity: ActivityRepository;
  let settings: SettingsRepository;
  const open = () => {
    database = new SqliteDatabase(directory);
    downloads = new DownloadRepository(database);
    library = new MediaRepository(database);
    activity = new ActivityRepository(database);
    settings = new SettingsRepository(database);
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-repos-"));
    open();
  });
  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips all job metadata and preserves signed URLs through a database reopen", () => {
    const complete: DownloadJob = {
      ...job("full", "completed"),
      pageUrl: "https://example.test/watch",
      thumbnail: "https://example.test/poster.jpg",
      formatId: "137",
      formatLabel: "1080p",
      resolution: "1920×1080",
      container: "mkv",
      quality: "selected",
      outputPath: "C:/Videos/Downloads/Film.mkv",
      downloadedBytes: 5_000_000_000,
      totalBytes: 5_000_000_000,
      progress: 100,
      speed: 1000,
      eta: 0,
      startedAt: 11,
      completedAt: 12,
      updatedAt: 12,
      attempts: 2,
      fromAnalysis: true,
      error: "downloadFailed",
    };
    downloads.save(complete);
    database.close();
    open();
    expect(downloads.get("full")).toEqual(complete);
    expect(downloads.list()).toEqual([complete]);
    expect(downloads.get("missing")).toBeUndefined();
  });

  it("upserts the same job, removes obsolete optional values, and binds titles safely", () => {
    downloads.save({ ...job("same"), speed: 40, eta: 12, error: "downloadFailed" });
    const changed = { ...job("same", "paused"), progress: 35, downloadedBytes: 50, updatedAt: 20 };
    downloads.save(changed);
    expect(downloads.list()).toEqual([changed]);
    expect(downloads.get("same")).not.toHaveProperty("speed");
    expect(downloads.get("same")).not.toHaveProperty("error");
    expect(library.list()).toEqual([]);
  });

  it("recovers every interrupted state as paused, retaining progress and leaving terminal states unchanged", () => {
    const statuses: DownloadStatus[] = [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const status of statuses)
      downloads.save({
        ...job(status, status),
        downloadedBytes: 20,
        totalBytes: 100,
        progress: 20,
        speed: 5,
        eta: 16,
        outputPath: "C:/Videos/Downloads/partial.mp4",
        startedAt: 11,
      });
    database.close();
    open();
    expect(downloads.recoverInterrupted(100)).toBe(4);
    for (const status of statuses.slice(0, 4)) {
      expect(downloads.get(status)).toMatchObject({
        status: "paused",
        progress: 20,
        downloadedBytes: 20,
        outputPath: "C:/Videos/Downloads/partial.mp4",
        updatedAt: 100,
      });
      expect(downloads.get(status)).not.toHaveProperty("speed");
      expect(downloads.get(status)).not.toHaveProperty("eta");
    }
    for (const status of statuses.slice(4))
      expect(downloads.get(status)).toMatchObject({ status, updatedAt: 10 });
    expect(downloads.recoverInterrupted(200)).toBe(0);
  });

  it("clears only completed jobs while retaining their library media", () => {
    downloads.save(job("done", "completed"));
    downloads.save(job("failed", "failed"));
    downloads.save(job("active", "downloading"));
    library.save({ ...media("downloaded"), sourceType: "download", downloadId: "done" });
    expect(downloads.deleteCompleted()).toBe(1);
    expect(downloads.get("done")).toBeUndefined();
    expect(downloads.list()).toHaveLength(2);
    expect(library.get("downloaded")?.localPath).toBe("C:/Videos/downloaded.mp4");
    expect(library.get("downloaded")).not.toHaveProperty("downloadId");
  });

  it("round-trips media, updates a known path without duplicate records, and omits absent fields", () => {
    const item = {
      ...media("one"),
      sourceUrl: "https://example.test/movie",
      thumbnailPath: "C:/Videos/Thumbnails/one.jpg",
      videoCodec: "h264",
      audioCodec: "aac",
      bitrate: 4000,
    };
    library.save(item);
    database.close();
    open();
    expect(library.getByPath(item.localPath)).toEqual(item);
    const updated = { ...media("one"), fileSize: 12_000_000_000, modifiedAt: 20, updatedAt: 20 };
    library.save(updated);
    expect(library.list()).toEqual([updated]);
    expect(library.get("one")).not.toHaveProperty("thumbnailPath");
    expect(library.getByPath("C:/Videos/missing.mp4")).toBeUndefined();
  });

  it("rejects a second media ID at the same normalized path without replacing the original", () => {
    const original = media("one", "C:/canonical/movie.mp4");
    library.save(original);
    expect(() => library.save(media("two", original.localPath))).toThrow(/^databaseFailed$/);
    expect(library.list()).toEqual([original]);
  });

  it("deduplicates lexical path aliases while retaining the actual path for filesystem actions", () => {
    const original = media("canonical", join(directory, "media", "movie.mp4"));
    library.save(original);
    const alias = `${directory}/media/../media/movie.mp4`;
    expect(library.getByPath(alias)).toEqual(original);
    expect(() => library.save(media("alias", alias))).toThrow(/^databaseFailed$/);
    expect(library.get("canonical")?.localPath).toBe(original.localPath);
  });

  it.runIf(process.platform === "win32")(
    "deduplicates Windows case variants without changing stored path casing",
    () => {
      const original = media("case", join(directory, "Media", "Movie.MP4"));
      library.save(original);
      expect(library.getByPath(original.localPath.toLowerCase())).toEqual(original);
      expect(() => library.save(media("other-case", original.localPath.toUpperCase()))).toThrow(
        /^databaseFailed$/,
      );
      expect(library.get("case")?.localPath).toBe(original.localPath);
    },
  );

  it("commits job completion and library insertion together and rolls both back on failure", () => {
    downloads.save(job("download", "processing"));
    expect(() =>
      database.transaction(() => {
        library.save({ ...media("movie"), sourceType: "download", downloadId: "download" });
        downloads.save({ ...job("download", "completed"), mediaId: "movie", progress: 100 });
        throw new Error("simulate disk metadata failure");
      }),
    ).toThrow(/^databaseFailed$/);
    expect(library.get("movie")).toBeUndefined();
    expect(downloads.get("download")?.status).toBe("processing");
    expect(
      database.transaction(() => {
        library.save({ ...media("movie"), sourceType: "download", downloadId: "download" });
        downloads.save({ ...job("download", "completed"), mediaId: "movie", progress: 100 });
        return "committed";
      }),
    ).toBe("committed");
    expect(downloads.get("download")?.mediaId).toBe("movie");
    expect(library.get("movie")?.downloadId).toBe("download");
  });

  it("removes library metadata and clears job linkage without deleting other records", () => {
    downloads.save(job("download", "completed"));
    library.save({ ...media("movie"), downloadId: "download", sourceType: "download" });
    downloads.save({ ...job("download", "completed"), mediaId: "movie" });
    expect(library.remove("movie")).toBe(true);
    expect(library.get("movie")).toBeUndefined();
    expect(downloads.get("download")?.status).toBe("completed");
    expect(downloads.get("download")).not.toHaveProperty("mediaId");
    expect(library.remove("missing")).toBe(false);
  });

  it("stores settings durably as JSON and safely rejects non-serializable values", () => {
    const value: DownloadSettings = {
      directory: "C:/Videos/Downloads",
      concurrency: 2,
      quality: "1080",
      container: "mp4",
      autoRetry: false,
    };
    expect(settings.get("missing")).toBeUndefined();
    settings.set("downloads", value);
    settings.set("false", false);
    settings.set("null", null);
    database.close();
    open();
    expect(settings.get<DownloadSettings>("downloads")).toEqual(value);
    expect(settings.get<boolean>("false")).toBe(false);
    expect(settings.get<null>("null")).toBeNull();
    expect(() => settings.set("invalid", undefined)).toThrow(/^databaseFailed$/);
    const cycle: { next?: unknown } = {};
    cycle.next = cycle;
    expect(() => settings.set("cycle", cycle)).toThrow(/^databaseFailed$/);
  });

  it("rejects asynchronous transaction callbacks and rolls back their initial writes", () => {
    expect(() =>
      database.transaction(() => {
        settings.set("uncommitted", true);
        return Promise.resolve("must not commit");
      }),
    ).toThrow(/^databaseFailed$/);
    expect(settings.get("uncommitted")).toBeUndefined();
  });

  it("returns the newest activity first and preserves history after jobs or media are removed", () => {
    const first: ActivityItem = {
      id: "one",
      type: "downloadCompleted",
      title: "Completed",
      createdAt: 10,
      downloadId: "old-download",
      mediaId: "old-media",
    };
    const second: ActivityItem = {
      id: "two",
      type: "downloadFailed",
      title: "Failed",
      createdAt: 20,
      error: "downloadFailed",
    };
    activity.add(first);
    activity.add(second);
    database.close();
    open();
    expect(activity.list()).toEqual([second, first]);
    expect(activity.list(1)).toEqual([second]);
    expect(activity.list()[1]).not.toHaveProperty("error");
  });

  it("enforces relational and numeric constraints with safe errors", () => {
    expect(() => library.save({ ...media("orphan"), downloadId: "missing" })).toThrow(
      /^databaseFailed$/,
    );
    expect(() => downloads.save({ ...job("invalid"), progress: 101 })).toThrow(/^databaseFailed$/);
    expect(downloads.list()).toEqual([]);
    expect(library.list()).toEqual([]);
  });
});
