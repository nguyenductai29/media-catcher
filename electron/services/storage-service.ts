import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { StorageCleanup, StorageSnapshot } from "../../shared/models";
import type { DownloadRepository } from "../repositories/download-repository";
import type { MediaRepository } from "../repositories/media-repository";
import type { SettingsRepository } from "../repositories/settings-repository";
import type { DownloadSettingsService } from "./download-settings-service";

interface StorageDependencies {
  userDataDirectory: string;
  settings: DownloadSettingsService;
  downloads: Pick<DownloadRepository, "list">;
  media: Pick<MediaRepository, "list">;
  repository: Pick<SettingsRepository, "get" | "set">;
}
const DAY = 86_400_000;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const thumbnail = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.jpg$/i;
const key = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, path: string) => {
  const rel = relative(key(root), key(path));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel))
  );
};

/** Counts selected storage; cleanup accepts fixed categories and never renderer paths. */
export class StorageService {
  private closing = false;
  private work: Promise<void> = Promise.resolve();
  private fingerprint: boolean;
  constructor(private readonly deps: StorageDependencies) {
    const saved = deps.repository.get<unknown>("storage");
    this.fingerprint =
      !!saved &&
      typeof saved === "object" &&
      "fingerprintEnabled" in saved &&
      saved.fingerprintEnabled === true;
  }
  fingerprintEnabled(): boolean {
    return this.fingerprint;
  }
  private assertOpen(): void {
    if (this.closing) throw new Error("unavailable");
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("unavailable"));
    const result = this.work
      .then(() => {
        this.assertOpen();
        return operation();
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && ["unavailable", "invalidInput"].includes(cause.message))
          throw cause;
        throw new Error("storageFailed", { cause });
      });
    this.work = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /** Every lookup rejects symlinks, including redirects in ancestor directories. */
  private async inspect(path: string) {
    this.assertOpen();
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || key(await realpath(path)) !== key(path)) return undefined;
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async bytes(path: string): Promise<number> {
    const info = await this.inspect(path);
    if (!info) return 0;
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const name of await readdir(path)) total += await this.bytes(join(path, name));
    return total;
  }
  private async snapshot(): Promise<StorageSnapshot> {
    let database = 0;
    for (const name of [
      "mediavault.db",
      "mediavault.db-wal",
      "mediavault.db-shm",
      "backups",
      "quarantine",
    ])
      database += await this.bytes(join(this.deps.userDataDirectory, name));
    return {
      downloads: await this.bytes(this.deps.settings.get().directory),
      temp: await this.bytes(this.deps.settings.tempDirectory),
      thumbnails: await this.bytes(this.deps.settings.thumbnailDirectory),
      database,
      logs: await this.bytes(join(this.deps.userDataDirectory, "logs")),
      fingerprintEnabled: this.fingerprint,
    };
  }
  get(): Promise<StorageSnapshot> {
    return this.run(() => this.snapshot());
  }
  setFingerprintEnabled(enabled: unknown): Promise<StorageSnapshot> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error("invalidInput"));
    return this.run(async () => {
      this.deps.repository.set("storage", { fingerprintEnabled: enabled });
      this.fingerprint = enabled;
      return this.snapshot();
    });
  }
  /** Refreshed before each unlink so a newly persisted job or library item wins. */
  private protectedPath(path: string, stagingId?: string): boolean {
    this.assertOpen();
    const jobs = this.deps.downloads.list();
    if (stagingId && jobs.some((job) => job.id.toLowerCase() === stagingId.toLowerCase()))
      return true;
    const destinations = [
      this.deps.settings.get().directory,
      ...jobs.map((job) => job.destinationDirectory),
    ];
    if (destinations.some((directory) => inside(path, directory) || inside(directory, path)))
      return true;
    const files = [
      ...jobs.flatMap((job) => (job.outputPath ? [job.outputPath] : [])),
      ...this.deps.media
        .list()
        .flatMap((item) =>
          item.thumbnailPath ? [item.localPath, item.thumbnailPath] : [item.localPath],
        ),
    ];
    return files.some((file) => inside(path, file));
  }
  private async oldTree(
    path: string,
    cutoff: number,
  ): Promise<{ files: string[]; directories: string[] } | undefined> {
    const info = await this.inspect(path);
    if (!info || info.mtimeMs > cutoff) return undefined;
    if (info.isFile()) return { files: [path], directories: [] };
    if (!info.isDirectory()) return undefined;
    const files: string[] = [],
      directories: string[] = [];
    for (const name of await readdir(path)) {
      const child = await this.oldTree(join(path, name), cutoff);
      if (!child) return undefined;
      files.push(...child.files);
      directories.push(...child.directories);
    }
    directories.push(path);
    return { files, directories };
  }
  private async removeStaging(): Promise<void> {
    const root = this.deps.settings.tempDirectory;
    if (!(await this.inspect(root))?.isDirectory()) return;
    const cutoff = Date.now() - DAY;
    for (const name of await readdir(root)) {
      if (!uuid.test(name)) continue;
      const candidate = join(root, name);
      if (this.protectedPath(candidate, name) || !(await this.inspect(candidate))?.isDirectory())
        continue;
      const tree = await this.oldTree(candidate, cutoff);
      if (!tree) continue;
      for (const path of tree.files) {
        const info = await this.inspect(path);
        if (!info?.isFile() || info.mtimeMs > cutoff || this.protectedPath(candidate, name)) break;
        this.assertOpen();
        await unlink(path);
      }
      for (const path of tree.directories) {
        if (this.protectedPath(candidate, name) || !(await this.inspect(path))?.isDirectory())
          break;
        this.assertOpen();
        try {
          await rmdir(path);
        } catch (error) {
          if (
            !["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
          )
            throw error;
        }
      }
    }
  }
  private async removeFiles(root: string, pattern: RegExp, maxAge: number): Promise<void> {
    if (!(await this.inspect(root))?.isDirectory()) return;
    const cutoff = Date.now() - maxAge;
    for (const name of await readdir(root)) {
      if (!pattern.test(name)) continue;
      const path = join(root, name);
      const info = await this.inspect(path);
      if (!info?.isFile() || info.mtimeMs > cutoff || this.protectedPath(path)) continue;
      this.assertOpen();
      await unlink(path);
    }
  }
  private async cleanup(action: StorageCleanup): Promise<void> {
    if (action === "staleTemp") await this.removeStaging();
    else if (action === "unusedThumbnails")
      await this.removeFiles(this.deps.settings.thumbnailDirectory, thumbnail, DAY);
    else
      await this.removeFiles(
        join(this.deps.userDataDirectory, "logs"),
        /^mediavault\.log\.\d+$/,
        7 * DAY,
      );
  }
  clean(action: unknown): Promise<StorageSnapshot> {
    if (action !== "staleTemp" && action !== "oldLogs" && action !== "unusedThumbnails")
      return Promise.reject(new Error("invalidInput"));
    return this.run(async () => {
      await this.cleanup(action);
      return this.snapshot();
    });
  }
  /** An inaccessible cache must not prevent the application opening. */
  async startupCleanup(): Promise<void> {
    await this.run(() => this.cleanup("staleTemp")).catch(() => {});
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.work;
  }
}
