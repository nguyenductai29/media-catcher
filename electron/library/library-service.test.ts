// @vitest-environment node
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadJob, MediaItem, MediaProbe } from "../../shared/models";
import { SqliteDatabase } from "../database/database";
import { MediaRepository } from "../repositories/media-repository";
import { SettingsRepository } from "../repositories/settings-repository";
import { ActivityRepository } from "../repositories/activity-repository";
import { DownloadSettingsService } from "../services/download-settings-service";
import { ActivityService } from "../services/activity-service";
import { LibraryService } from "./library-service";
import * as fingerprinting from "./content-fingerprint";

describe("local media library", () => {
  let directory: string;
  let database: SqliteDatabase;
  let repository: MediaRepository;
  let settings: DownloadSettingsService;
  let activity: ActivityService;
  let service: LibraryService;
  let fingerprintEnabled = false;
  const probe = vi.fn(async (path: string): Promise<MediaProbe> => ({
    duration: 12,
    width: 320,
    height: 180,
    videoCodec: "h264",
    audioCodec: "aac",
    bitrate: 128000,
    container: "mp4",
    fileSize: (await stat(path)).size,
    hasVideo: true,
    hasAudio: true,
  }));
  const thumbnail = vi.fn(
    async (
      _path: string,
      output: string,
      _duration?: number,
      _signal?: AbortSignal,
    ): Promise<void> => {
      await mkdir(settings.thumbnailDirectory, { recursive: true });
      await writeFile(output, "thumbnail");
    },
  );
  const fixture = async (name = "Movie.mp4", body = "fixture media") => {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
    return path;
  };
  const uploaded = async (patch: Partial<MediaItem> = {}) => {
    const path = await fixture();
    await service.importFiles([path]);
    const item = {
      ...service.list()[0]!,
      localAvailable: true,
      driveAvailable: true,
      driveFileId: "drive-file",
      driveAccountId: "account-one",
      driveUploadedAt: 1234,
      driveStatus: "completed" as const,
      ...patch,
    };
    repository.save(item);
    return item;
  };
  const expectedUpload = (item: MediaItem) => ({
    driveFileId: "drive-file",
    providerAccountId: "account-one",
    fileSize: item.fileSize,
    modifiedAt: item.modifiedAt,
  });
  const deferFingerprint = () => {
    const original = fingerprinting.contentFingerprint;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fingerprinting, "contentFingerprint").mockImplementationOnce(async (path, signal) => {
      const result = await original(path, signal);
      entered();
      await gate;
      return result;
    });
    return { started, release };
  };
  it("retains a backfilled fingerprint when refresh restores local availability", async () => {
    const item = await uploaded({ localAvailable: false });
    fingerprintEnabled = true;
    await service.refresh();
    expect(service.get(item.id)).toMatchObject({
      localAvailable: true,
      contentFingerprint: expect.stringMatching(/^sample-v1:/),
      driveFileId: item.driveFileId,
      driveStatus: "completed",
    });
  });
  it("does not resurrect a record removed while refresh backfills its fingerprint", async () => {
    const item = await uploaded({ localAvailable: false });
    fingerprintEnabled = true;
    const hash = deferFingerprint();
    const refresh = service.refresh();
    await hash.started;
    try {
      service.remove(item.id);
    } finally {
      hash.release();
    }
    await refresh;
    expect(repository.get(item.id)).toBeUndefined();
    await expect(access(item.localPath)).resolves.toBeUndefined();
  });
  it("preserves cloud metadata committed while refresh backfills a restored file", async () => {
    const item = await uploaded({ localAvailable: false });
    fingerprintEnabled = true;
    const hash = deferFingerprint();
    const refresh = service.refresh();
    await hash.started;
    try {
      repository.save({
        ...service.get(item.id),
        driveFileId: "new-cloud-file",
        driveUploadedAt: 5678,
      });
    } finally {
      hash.release();
    }
    await refresh;
    expect(service.get(item.id)).toMatchObject({
      localAvailable: true,
      contentFingerprint: expect.stringMatching(/^sample-v1:/),
      driveFileId: "new-cloud-file",
      driveUploadedAt: 5678,
    });
  });
  it("optionally skips simultaneous content copies without deleting either file", async () => {
    fingerprintEnabled = true;
    const first = await fixture("original.mp4"),
      second = await fixture("copy.mp4");
    expect(await service.importFiles([first, second])).toEqual({ added: 1, skipped: 1, failed: 0 });
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]?.contentFingerprint).toMatch(/^sample-v1:/);
    await expect(access(first)).resolves.toBeUndefined();
    await expect(access(second)).resolves.toBeUndefined();
  });
  it("backfills optional fingerprints on refresh and ignores stale duplicate records", async () => {
    const first = await fixture("original.mp4"),
      second = await fixture("copy.mp4");
    await service.importFiles([first]);
    expect(service.list()[0]?.contentFingerprint).toBeUndefined();
    fingerprintEnabled = true;
    await service.refresh();
    expect(service.list()[0]?.contentFingerprint).toMatch(/^sample-v1:/);
    expect((await service.importFiles([second])).skipped).toBe(1);
    await unlink(first);
    expect((await service.importFiles([second])).added).toBe(1);
  });
  it("keeps local bytes when disconnect aborts post-upload deletion during validation", async () => {
    const item = await uploaded();
    const controller = new AbortController();
    const validate = service.validateKnownFile.bind(service);
    vi.spyOn(service, "validateKnownFile").mockImplementationOnce(async (id) => {
      const path = await validate(id);
      controller.abort();
      return path;
    });
    await expect(
      service.deleteAfterUpload(item.id, expectedUpload(item), controller.signal),
    ).rejects.toThrow("cancelled");
    await expect(access(item.localPath)).resolves.toBeUndefined();
    expect(repository.get(item.id)?.localAvailable).toBe(true);
  });
  beforeEach(async () => {
    fingerprintEnabled = false;
    directory = await mkdtemp(join(tmpdir(), "mediavault-library-"));
    database = new SqliteDatabase(join(directory, "data"));
    repository = new MediaRepository(database);
    settings = new DownloadSettingsService(
      new SettingsRepository(database),
      join(directory, "videos"),
    );
    activity = new ActivityService(new ActivityRepository(database));
    probe.mockClear();
    thumbnail.mockClear();
    service = new LibraryService({
      database,
      media: repository,
      settings,
      activity,
      fingerprintEnabled: () => fingerprintEnabled,
      ffmpeg: { probeMedia: probe, extractThumbnail: thumbnail },
    });
  });
  afterEach(async () => {
    await service.shutdown();
    activity.dispose();
    database.close();
    vi.restoreAllMocks();
    probe.mockReset();
    thumbnail.mockReset();
    probe.mockImplementation(async (path: string) => ({
      duration: 12,
      width: 320,
      height: 180,
      videoCodec: "h264",
      audioCodec: "aac",
      bitrate: 128000,
      container: "mp4",
      fileSize: (await stat(path)).size,
      hasVideo: true,
      hasAudio: true,
    }));
    thumbnail.mockImplementation(async (_path, output) => {
      await mkdir(settings.thumbnailDirectory, { recursive: true });
      await writeFile(output, "thumbnail");
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("imports the actual file path and typed metadata without copying the movie", async () => {
    const path = await fixture();
    const event = new Promise<unknown>((resolve) => service.events.subscribe(resolve));
    expect(await service.importFiles([path])).toEqual({ added: 1, skipped: 0, failed: 0 });
    const item = service.list()[0]!;
    expect(item).toMatchObject({
      title: "Movie",
      localPath: path,
      sourceType: "local",
      duration: 12,
      width: 320,
      height: 180,
      resolution: "320×180",
      container: "mp4",
      fileSize: 13,
    });
    expect(await readFile(path, "utf8")).toBe("fixture media");
    expect(item.thumbnailPath?.startsWith(settings.thumbnailDirectory)).toBe(true);
    expect(await readFile(item.thumbnailPath!, "utf8")).toBe("thumbnail");
    expect((await event) as unknown[]).toHaveLength(1);
    expect(activity.list().map((entry) => entry.type)).toEqual(["mediaAdded"]);
  });

  it("serializes concurrent imports of the same path and skips unchanged files", async () => {
    const path = await fixture();
    const [one, two] = await Promise.all([
      service.importFiles([path]),
      service.importFiles([path]),
    ]);
    expect(one.added + two.added).toBe(1);
    expect(one.skipped + two.skipped).toBe(1);
    expect(service.list()).toHaveLength(1);
    expect(await service.importFiles([path])).toEqual({ added: 0, skipped: 1, failed: 0 });
  });

  it("refreshes changed file metadata without creating a duplicate record", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    const id = service.list()[0]!.id;
    await writeFile(path, "updated larger media file");
    const items = await service.refresh();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(id);
    expect(items[0]?.fileSize).toBe((await stat(path)).size);
    await unlink(path);
    expect(await service.refresh()).toHaveLength(1);
    await expect(service.validateKnownFile(id)).rejects.toThrow(/^fileMissing$/);
  });

  it("skips unsupported formats and keeps invalid media out of the database", async () => {
    const text = await fixture("notes.txt"),
      bad = await fixture("broken.mp4");
    probe.mockRejectedValueOnce(new Error("probeFailed"));
    expect(await service.importFiles([text, bad, join(directory, "absent.mp4")])).toEqual({
      added: 0,
      skipped: 1,
      failed: 2,
    });
    expect(service.list()).toEqual([]);
    expect(activity.list()).toEqual([]);
  });

  it("retains valid imports when optional thumbnail generation fails", async () => {
    thumbnail.mockRejectedValueOnce(new Error("binaryMissing"));
    expect((await service.importFiles([await fixture()])).added).toBe(1);
    expect(service.list()[0]).not.toHaveProperty("thumbnailPath");
  });

  it("still imports valid media if the thumbnail destination cannot be created", async () => {
    await mkdir(join(settings.thumbnailDirectory, ".."), { recursive: true });
    await writeFile(settings.thumbnailDirectory, "not a directory");
    expect((await service.importFiles([await fixture()])).added).toBe(1);
    expect(service.list()[0]).not.toHaveProperty("thumbnailPath");
  });

  it("does not resurrect a library record removed while refresh is probing it", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    const id = service.list()[0]!.id;
    await writeFile(path, "changed media needing refresh");
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    probe.mockImplementationOnce(async () => {
      begin();
      await gate;
      return {
        container: "mp4",
        fileSize: (await stat(path)).size,
        hasVideo: false,
        hasAudio: true,
      };
    });
    const refresh = service.refresh();
    await started;
    service.remove(id);
    release();
    await refresh;
    expect(service.list()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("changed media needing refresh");
  });

  it("aborts and drains probing before shutdown resolves and prevents new imports", async () => {
    const path = await fixture();
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    probe.mockImplementationOnce(async (_path, signal?: AbortSignal) => {
      begin();
      return new Promise<MediaProbe>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    });
    const importing = service.importFiles([path]);
    const rejected = expect(importing).rejects.toThrow(/^cancelled$/);
    await started;
    await service.shutdown();
    await rejected;
    expect(service.list()).toEqual([]);
    await expect(service.importFiles([path])).rejects.toThrow(/^unavailable$/);
  });

  it("does not register a file that changes during probing", async () => {
    const path = await fixture();
    probe.mockImplementationOnce(async () => {
      await writeFile(path, "replacement content with different length");
      return { container: "mp4", fileSize: 13, hasVideo: true, hasAudio: false };
    });
    expect(await service.importFiles([path])).toEqual({ added: 0, skipped: 0, failed: 1 });
    expect(service.list()).toEqual([]);
  });

  it("scans only the selected folder, honors recursion, and skips directory junctions", async () => {
    const selected = join(directory, "selected"),
      outside = join(directory, "outside");
    await fixture("selected/top.mp4");
    await fixture("selected/nested/child.mkv");
    await fixture("outside/private.mp4");
    await symlink(
      outside,
      join(selected, "junction"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await service.importFolder(selected, false)).added).toBe(1);
    expect(await service.importFolder(selected, true)).toEqual({ added: 1, skipped: 1, failed: 0 });
    expect(service.list().some((item) => item.localPath.includes("outside"))).toBe(false);
  });

  it("bounds expensive probing to two files while importing all selected files", async () => {
    let active = 0,
      maximum = 0;
    probe.mockImplementation(async (path) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          container: "mp4",
          fileSize: (await stat(path)).size,
          hasVideo: true,
          hasAudio: false,
        };
      } finally {
        active--;
      }
    });
    const paths = await Promise.all(
      Array.from({ length: 5 }, (_, index) => fixture(`${index}.mp4`)),
    );
    expect((await service.importFiles(paths)).added).toBe(5);
    expect(maximum).toBe(2);
    expect(service.list()).toHaveLength(5);
  });

  it("removes library metadata while leaving the local file untouched", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    service.remove(service.list()[0]!.id);
    expect(service.list()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("fixture media");
    expect(activity.list().some((item) => item.type === "mediaRemoved")).toBe(true);
  });

  it("cleans owned thumbnails on removal but never deletes a thumbnail outside its managed directory", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    const item = service.list()[0]!;
    service.remove(item.id);
    await service.shutdown();
    await expect(access(item.thumbnailPath!)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("fixture media");
    service = new LibraryService({
      database,
      media: repository,
      settings,
      activity,
      ffmpeg: { probeMedia: probe, extractThumbnail: thumbnail },
    });
    await service.importFiles([path]);
    const other = service.list()[0]!;
    const external = join(directory, "private.jpg");
    await writeFile(external, "private image");
    repository.save({ ...other, thumbnailPath: external });
    service.remove(other.id);
    await service.shutdown();
    expect(await readFile(external, "utf8")).toBe("private image");
  });

  it("deletes only a known unchanged file and then removes its database record", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    const id = service.list()[0]!.id;
    expect(await service.validateKnownFile(id)).toBe(path);
    await service.deleteFile(id);
    await expect(access(path)).rejects.toThrow();
    expect(service.list()).toEqual([]);
    expect(activity.list().some((item) => item.type === "fileDeleted")).toBe(true);
  });

  it("refuses deletion of replaced files and rejects unknown record IDs", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    const id = service.list()[0]!.id;
    await writeFile(path, "changed replacement");
    await expect(service.deleteFile(id)).rejects.toThrow(/^fileChanged$/);
    await expect(service.deleteFile("unknown")).rejects.toThrow(/^invalidInput$/);
    expect(await readFile(path, "utf8")).toBe("changed replacement");
    expect(service.list()).toHaveLength(1);
  });

  it("detects modification timestamps even when replacement size is identical", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    await utimes(path, new Date(), new Date(1_700_000_000_000));
    await expect(service.validateKnownFile(service.list()[0]!.id)).rejects.toThrow(/^fileChanged$/);
  });

  it("prepares downloaded metadata without writing database records before the manager transaction", async () => {
    const path = await fixture("download.mp4"),
      info = await stat(path);
    const job: DownloadJob = {
      id: "job",
      sourceUrl: "https://example.test/video",
      title: "Downloaded title",
      container: "mp4",
      quality: "best",
      destinationDirectory: directory,
      downloadedBytes: 13,
      progress: 99,
      status: "processing",
      createdAt: 1,
      updatedAt: 1,
      attempts: 1,
      fromAnalysis: false,
    };
    const item = await service.prepareDownloadedMedia(
      job,
      { outputPath: path, modifiedAt: info.mtimeMs, probe: await probe(path) },
      new AbortController().signal,
    );
    expect(item).toMatchObject({
      sourceType: "download",
      downloadId: "job",
      title: "Downloaded title",
      localPath: path,
      fileSize: info.size,
    });
    expect(service.list()).toEqual([]);
    expect(activity.list()).toEqual([]);
  });

  it("rejects downloaded paths outside the destination and aborted preparation", async () => {
    const path = await fixture("outside.mp4"),
      info = await stat(path);
    const destination = join(directory, "destination");
    await mkdir(destination);
    const job: DownloadJob = {
      id: "job",
      sourceUrl: "https://example.test/video",
      title: "Movie",
      container: "mp4",
      quality: "best",
      destinationDirectory: destination,
      downloadedBytes: 13,
      progress: 99,
      status: "processing",
      createdAt: 1,
      updatedAt: 1,
      attempts: 1,
      fromAnalysis: false,
    };
    const file = { outputPath: path, modifiedAt: info.mtimeMs, probe: await probe(path) };
    await expect(
      service.prepareDownloadedMedia(job, file, new AbortController().signal),
    ).rejects.toThrow(/^invalidInput$/);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.prepareDownloadedMedia(
        { ...job, destinationDirectory: directory },
        file,
        controller.signal,
      ),
    ).rejects.toThrow(/^cancelled$/);
    expect(service.list()).toEqual([]);
  });

  it("keeps verified Drive metadata and its thumbnail after automatic local deletion", async () => {
    const item = await uploaded();
    await service.deleteAfterUpload(item.id, expectedUpload(item));
    await expect(access(item.localPath)).rejects.toThrow();
    expect(service.get(item.id)).toMatchObject({
      localPath: item.localPath,
      localAvailable: false,
      driveAvailable: true,
      driveFileId: "drive-file",
      driveAccountId: "account-one",
      driveStatus: "completed",
      thumbnailPath: item.thumbnailPath,
    });
    expect(await readFile(item.thumbnailPath!, "utf8")).toBe("thumbnail");
    expect(
      activity.list().filter((entry) => entry.type === "localFileDeletedAfterUpload"),
    ).toHaveLength(1);
    await expect(service.validateKnownFile(item.id)).rejects.toThrow(/^fileMissing$/);
  });

  it.each([
    { driveAvailable: false },
    { driveStatus: "finalizing" as const },
    { driveStatus: "changed" as const },
    { driveFileId: "other-file" },
    { driveAccountId: "other-account" },
  ])(
    "never automatically deletes without the exact committed cloud association: %j",
    async (patch) => {
      const item = await uploaded(patch);
      await expect(service.deleteAfterUpload(item.id, expectedUpload(item))).rejects.toThrow();
      expect(await readFile(item.localPath, "utf8")).toBe("fixture media");
      expect(activity.list().some((entry) => entry.type === "localFileDeletedAfterUpload")).toBe(
        false,
      );
    },
  );

  it("rejects automatic deletion when the confirmation fingerprint or actual file changed", async () => {
    const item = await uploaded();
    await expect(
      service.deleteAfterUpload(item.id, {
        ...expectedUpload(item),
        fileSize: item.fileSize + 1,
      }),
    ).rejects.toThrow(/^fileChanged$/);
    await expect(
      service.deleteAfterUpload(item.id, {
        ...expectedUpload(item),
        modifiedAt: item.modifiedAt + 1,
      }),
    ).rejects.toThrow(/^fileChanged$/);
    await writeFile(item.localPath, "replacement media");
    await expect(service.deleteAfterUpload(item.id, expectedUpload(item))).rejects.toThrow(
      /^fileChanged$/,
    );
    expect(await readFile(item.localPath, "utf8")).toBe("replacement media");
    expect(service.get(item.id).localAvailable).toBe(true);
  });

  it("rechecks a cloud association changed while local deletion was being validated", async () => {
    const item = await uploaded();
    const validate = service.validateKnownFile.bind(service);
    vi.spyOn(service, "validateKnownFile").mockImplementationOnce(async (id) => {
      const path = await validate(id);
      repository.save({ ...service.get(id), driveAccountId: "account-two" });
      return path;
    });
    await expect(service.deleteAfterUpload(item.id, expectedUpload(item))).rejects.toThrow();
    expect(await readFile(item.localPath, "utf8")).toBe("fixture media");
    expect(service.get(item.id).driveAccountId).toBe("account-two");
  });

  it("rechecks actual bytes after asynchronous validation before automatic unlink", async () => {
    const item = await uploaded();
    const validate = service.validateKnownFile.bind(service);
    vi.spyOn(service, "validateKnownFile").mockImplementationOnce(async (id) => {
      const path = await validate(id);
      await writeFile(path, "replacement arrived after the initial validation");
      return path;
    });
    await expect(service.deleteAfterUpload(item.id, expectedUpload(item))).rejects.toThrow(
      /^fileChanged$/,
    );
    expect(await readFile(item.localPath, "utf8")).toBe(
      "replacement arrived after the initial validation",
    );
    expect(service.get(item.id).localAvailable).toBe(true);
  });

  it("manual deletion keeps a Drive-only record while local-only deletion still removes it", async () => {
    const item = await uploaded();
    await service.deleteFile(item.id);
    await expect(access(item.localPath)).rejects.toThrow();
    expect(service.get(item.id)).toMatchObject({
      localAvailable: false,
      driveAvailable: true,
      driveFileId: "drive-file",
    });
    expect(await readFile(item.thumbnailPath!, "utf8")).toBe("thumbnail");
    expect(activity.list().some((entry) => entry.type === "fileDeleted")).toBe(true);
    expect(activity.list().some((entry) => entry.type === "localFileDeletedAfterUpload")).toBe(
      false,
    );
  });

  it("refresh marks a missing local copy unavailable without losing its cloud record", async () => {
    const item = await uploaded();
    await unlink(item.localPath);
    await service.refresh();
    expect(service.get(item.id)).toMatchObject({
      localAvailable: false,
      driveAvailable: true,
      driveFileId: "drive-file",
      driveStatus: "completed",
    });
    expect(repository.getByPath(item.localPath)).toBeUndefined();
    expect(await readFile(item.thumbnailPath!, "utf8")).toBe("thumbnail");
  });

  it("does not validate or claim bytes reusing the last known path of an unavailable cloud item", async () => {
    const item = await uploaded({ localAvailable: false });
    // Even an indistinguishable pathname/fingerprint is untrusted until an explicit refresh.
    await expect(service.validateKnownFile(item.id)).rejects.toThrow(/^fileMissing$/);
    await writeFile(item.localPath, "a different local movie using the same pathname");
    await service.refresh();
    expect(service.get(item.id)).toMatchObject({
      localAvailable: false,
      fileSize: 13,
      driveFileId: "drive-file",
    });
    expect((await service.importFiles([item.localPath])).added).toBe(1);
    const local = repository.getByPath(item.localPath)!;
    expect(local.id).not.toBe(item.id);
    expect(local.driveFileId).toBeUndefined();
    await service.refresh();
    expect(service.get(item.id).localAvailable).toBe(false);
    expect(repository.getByPath(item.localPath)?.id).toBe(local.id);
  });

  it("restores availability only for the same unclaimed local file", async () => {
    const item = await uploaded({ localAvailable: false });
    await service.refresh();
    expect(service.get(item.id)).toMatchObject({
      localAvailable: true,
      driveFileId: "drive-file",
      driveStatus: "completed",
    });
    expect(await service.validateKnownFile(item.id)).toBe(item.localPath);
  });

  it("refresh preserves a cloud association but marks a changed local version unsafe for auto-delete", async () => {
    const item = await uploaded();
    await writeFile(item.localPath, "changed local version of the movie");
    await service.refresh();
    const changed = service.get(item.id);
    expect(changed).toMatchObject({
      localAvailable: true,
      driveAvailable: true,
      driveFileId: "drive-file",
      driveAccountId: "account-one",
      driveStatus: "changed",
    });
    expect(changed.fileSize).toBe(34);
    await expect(service.deleteAfterUpload(item.id, expectedUpload(changed))).rejects.toThrow();
    expect(await readFile(item.localPath, "utf8")).toBe("changed local version of the movie");
  });

  it("merges cloud completion committed while refresh was probing instead of dropping it", async () => {
    const path = await fixture();
    await service.importFiles([path]);
    const item = service.list()[0]!;
    await writeFile(path, "changed local version of the movie");
    probe.mockImplementationOnce(async () => {
      repository.save({
        ...service.get(item.id),
        driveAvailable: true,
        driveFileId: "recent-file",
        driveAccountId: "account-one",
        driveUploadedAt: 4567,
        driveStatus: "completed",
      });
      return {
        container: "mp4",
        fileSize: (await stat(path)).size,
        hasVideo: true,
        hasAudio: true,
      };
    });
    await service.refresh();
    expect(service.get(item.id)).toMatchObject({
      driveAvailable: true,
      driveFileId: "recent-file",
      driveAccountId: "account-one",
      driveUploadedAt: 4567,
      driveStatus: "changed",
    });
  });
});
