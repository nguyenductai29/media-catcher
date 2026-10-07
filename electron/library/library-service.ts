import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, realpath, stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { DownloadJob, ImportSummary, MediaItem, MediaProbe } from "../../shared/models";
import type { SqliteDatabase } from "../database/database";
import type { MediaRepository } from "../repositories/media-repository";
import type { DownloadedFile } from "../downloads/download-worker";
import { fileErrorCode, validateOwnedFile } from "../downloads/download-files";
import type { ActivityService } from "../services/activity-service";
import type { DownloadSettingsService } from "../services/download-settings-service";
import type { FFmpegService } from "../services/ffmpeg-service";
import { SnapshotEvents } from "../services/snapshot-events";

interface Dependencies {
  database: SqliteDatabase;
  media: MediaRepository;
  ffmpeg: Pick<FFmpegService, "probeMedia" | "extractThumbnail">;
  settings: DownloadSettingsService;
  activity: ActivityService;
}
interface LocalFile {
  path: string;
  info: Stats;
}
type Outcome = "added" | "skipped";
const formats = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".m4v",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac",
  ".wav",
]);
const pathKey = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("cancelled");
};

async function inspectFile(path: string): Promise<LocalFile> {
  if (!isAbsolute(path) || /[\p{Cc}]/u.test(path)) throw new Error("invalidInput");
  try {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error("fileMissing");
    return { path: canonical, info };
  } catch (error) {
    if (error instanceof Error && ["invalidInput", "fileMissing"].includes(error.message))
      throw error;
    throw new Error(fileErrorCode(error) === "ENOENT" ? "fileMissing" : "fileAccessDenied");
  }
}
function sameFile(file: LocalFile, size: number, modifiedAt: number): void {
  if (file.info.size !== size || file.info.mtimeMs !== modifiedAt) throw new Error("fileChanged");
}
async function* selectedFiles(paths: readonly string[]): AsyncGenerator<string> {
  yield* paths;
}

export class LibraryService {
  readonly events = new SnapshotEvents(() => this.list());
  private readonly controller = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly importing = new Map<string, Promise<Outcome>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private closing = false;

  constructor(private readonly deps: Dependencies) {}
  list(): MediaItem[] {
    return this.deps.media.list();
  }
  get(id: string): MediaItem {
    const item = this.deps.media.get(id);
    if (!item) throw new Error("invalidInput");
    return item;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("unavailable"));
    const pending = operation();
    this.operations.add(pending);
    return pending.finally(() => this.operations.delete(pending));
  }
  private async limited<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running < 2) this.running++;
    else await new Promise<void>((release) => this.waiting.push(release));
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  private async thumbnail(
    file: LocalFile,
    probe: MediaProbe,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    check(signal);
    if (!probe.hasVideo) return undefined;
    const path = join(this.deps.settings.thumbnailDirectory, `${randomUUID()}.jpg`);
    try {
      await mkdir(this.deps.settings.thumbnailDirectory, { recursive: true });
      await this.deps.ffmpeg.extractThumbnail(file.path, path, probe.duration, signal);
      check(signal);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error("probeFailed");
      return path;
    } catch (error) {
      await unlink(path).catch(() => undefined);
      if (signal.aborted || (error instanceof Error && error.message === "cancelled"))
        throw new Error("cancelled");
      return undefined;
    }
  }

  private async removeThumbnail(path?: string): Promise<void> {
    if (
      !path ||
      !isAbsolute(path) ||
      pathKey(dirname(path)) !== pathKey(this.deps.settings.thumbnailDirectory) ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.jpg$/i.test(basename(path))
    )
      return;
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) await unlink(path);
    } catch {
      /* A missing/locked cache image must not fail the media operation. */
    }
  }

  private async metadata(
    file: LocalFile,
    probe: MediaProbe,
    base: {
      title: string;
      sourceType: MediaItem["sourceType"];
      sourceUrl?: string;
      downloadId?: string;
    },
    signal: AbortSignal,
  ): Promise<MediaItem> {
    check(signal);
    sameFile(file, probe.fileSize, file.info.mtimeMs);
    const previous = this.deps.media.getByPath(file.path);
    const thumbnailPath = await this.thumbnail(file, probe, signal);
    try {
      check(signal);
      const after = await inspectFile(file.path);
      sameFile(after, file.info.size, file.info.mtimeMs);
      if (pathKey(after.path) !== pathKey(file.path)) throw new Error("fileChanged");
      const width = probe.width ?? 0,
        height = probe.height ?? 0,
        now = Date.now();
      return {
        id: previous?.id ?? randomUUID(),
        ...base,
        localPath: file.path,
        duration: probe.duration ?? 0,
        width,
        height,
        resolution: width && height ? `${width}×${height}` : "",
        container: probe.container,
        fileSize: probe.fileSize,
        modifiedAt: file.info.mtimeMs,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        ...(probe.videoCodec ? { videoCodec: probe.videoCodec } : {}),
        ...(probe.audioCodec ? { audioCodec: probe.audioCodec } : {}),
        ...(probe.bitrate !== undefined ? { bitrate: probe.bitrate } : {}),
        ...(thumbnailPath ? { thumbnailPath } : {}),
      };
    } catch (error) {
      if (thumbnailPath) await unlink(thumbnailPath).catch(() => undefined);
      throw error;
    }
  }

  private async importOne(
    path: string,
    signal: AbortSignal,
    existingOnly: boolean,
  ): Promise<Outcome> {
    check(signal);
    if (!formats.has(extname(path).toLowerCase())) return "skipped";
    const original = await inspectFile(path);
    const key = pathKey(original.path);
    // A waiting import rechecks the map after its predecessor settles.
    while (this.importing.has(key)) {
      await this.importing.get(key)!.catch(() => undefined);
      check(signal);
    }
    const pending = this.limited(async (): Promise<Outcome> => {
      check(signal);
      const file = await inspectFile(original.path);
      const previous = this.deps.media.getByPath(file.path);
      if (existingOnly && !previous) return "skipped";
      if (
        previous &&
        previous.fileSize === file.info.size &&
        previous.modifiedAt === file.info.mtimeMs
      )
        return "skipped";
      const probe = await this.deps.ffmpeg.probeMedia(file.path, signal);
      const item = await this.metadata(
        file,
        probe,
        {
          title: previous?.title ?? basename(file.path, extname(file.path)),
          sourceType: previous?.sourceType ?? "local",
          ...(previous?.sourceUrl ? { sourceUrl: previous.sourceUrl } : {}),
          ...(previous?.downloadId ? { downloadId: previous.downloadId } : {}),
        },
        signal,
      );
      check(signal);
      if (previous && !this.deps.media.get(previous.id)) {
        await this.removeThumbnail(item.thumbnailPath);
        return "skipped";
      }
      this.deps.database.transaction(() => {
        this.deps.media.save(item);
        if (!previous) this.deps.activity.add("mediaAdded", item.title, { mediaId: item.id });
      });
      if (previous?.thumbnailPath !== item.thumbnailPath)
        await this.removeThumbnail(previous?.thumbnailPath);
      this.events.notify();
      return "added";
    });
    this.importing.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.importing.get(key) === pending) this.importing.delete(key);
    }
  }

  private async consume(
    paths: AsyncIterable<string>,
    signal: AbortSignal,
    existingOnly = false,
  ): Promise<ImportSummary> {
    const summary: ImportSummary = { added: 0, skipped: 0, failed: 0 };
    const iterator = paths[Symbol.asyncIterator]();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, async () => {
          while (true) {
            check(signal);
            const next = await iterator.next();
            if (next.done) return;
            try {
              summary[await this.importOne(next.value, signal, existingOnly)]++;
            } catch (error) {
              if (signal.aborted || (error instanceof Error && error.message === "cancelled"))
                throw new Error("cancelled");
              summary.failed++;
            }
          }
        }),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
      return summary;
    } finally {
      await iterator.return?.();
    }
  }

  importFiles(paths: string[]): Promise<ImportSummary> {
    return this.track(() => this.consume(selectedFiles(paths), this.controller.signal));
  }
  importFolder(path: string, recursive: boolean): Promise<ImportSummary> {
    return this.track(async () => {
      if (!isAbsolute(path) || /[\p{Cc}]/u.test(path)) throw new Error("invalidInput");
      let root: string;
      try {
        root = await realpath(path);
        if (!(await stat(root)).isDirectory()) throw new Error("invalidInput");
      } catch {
        throw new Error("fileAccessDenied");
      }
      return this.consume(this.walk(root, recursive), this.controller.signal);
    });
  }
  private async *walk(directory: string, recursive: boolean): AsyncGenerator<string> {
    check(this.controller.signal);
    const entries = await opendir(directory);
    for await (const entry of entries) {
      check(this.controller.signal);
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && recursive) yield* this.walk(path, true);
      else if (entry.isFile() && formats.has(extname(entry.name).toLowerCase())) yield path;
    }
  }

  refresh(): Promise<MediaItem[]> {
    return this.track(async () => {
      await this.consume(
        selectedFiles(this.list().map((item) => item.localPath)),
        this.controller.signal,
        true,
      );
      return this.list();
    });
  }

  validateKnownFile(id: string): Promise<string> {
    return this.track(async () => {
      const item = this.get(id);
      const file = await inspectFile(item.localPath);
      if (pathKey(file.path) !== pathKey(item.localPath)) throw new Error("fileChanged");
      const current = await lstat(item.localPath);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error("fileChanged");
      sameFile(file, item.fileSize, item.modifiedAt);
      return file.path;
    });
  }

  remove(id: string): void {
    if (this.closing) throw new Error("unavailable");
    const item = this.get(id);
    this.deps.database.transaction(() => {
      this.deps.media.remove(id);
      this.deps.activity.add("mediaRemoved", item.title, { mediaId: id });
    });
    void this.track(() => this.removeThumbnail(item.thumbnailPath)).catch(() => undefined);
    this.events.notify();
  }
  deleteFile(id: string): Promise<void> {
    return this.track(async () => {
      const item = this.get(id);
      const path = await this.validateKnownFile(id);
      check(this.controller.signal);
      if (this.get(id).localPath !== item.localPath) throw new Error("fileChanged");
      try {
        await unlink(path);
      } catch (error) {
        throw new Error(fileErrorCode(error) === "ENOENT" ? "fileMissing" : "fileAccessDenied");
      }
      this.deps.database.transaction(() => {
        this.deps.media.remove(id);
        this.deps.activity.add("fileDeleted", item.title, { mediaId: id });
      });
      await this.removeThumbnail(item.thumbnailPath);
      this.events.notify();
    });
  }

  prepareDownloadedMedia(
    job: DownloadJob,
    downloaded: DownloadedFile,
    signal: AbortSignal,
  ): Promise<MediaItem> {
    return this.track(async () => {
      const combined = AbortSignal.any([signal, this.controller.signal]);
      check(combined);
      const path = await validateOwnedFile(job.destinationDirectory, downloaded.outputPath);
      const file = await inspectFile(path);
      sameFile(file, downloaded.probe.fileSize, downloaded.modifiedAt);
      return this.metadata(
        file,
        downloaded.probe,
        {
          title: job.title,
          sourceType: "download",
          sourceUrl: job.pageUrl ?? job.sourceUrl,
          downloadId: job.id,
        },
        combined,
      );
    });
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.controller.abort();
    await Promise.allSettled([...this.operations]);
    this.events.dispose();
  }
}
