import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type {
  DiagnosticLogEntry,
  DiagnosticsSnapshot,
  DownloadStatus,
  DriveUploadStatus,
} from "../../shared/models";
import { LocalLogger, validateLogFilter } from "./local-logger";

export interface DiagnosticsDependencies {
  snapshot(): Promise<DiagnosticsSnapshot>;
  jobStatuses(): {
    downloads: ReadonlyArray<{ status: string }>;
    uploads: ReadonlyArray<{ status: string }>;
  };
  logger: LocalLogger;
  userDataDirectory: string;
  protectedDirectories: readonly string[];
  chooseExportPath(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  writeClipboard(text: string): void | Promise<void>;
}
const downloadStates = {
  queued: 0,
  analyzing: 0,
  downloading: 0,
  processing: 0,
  paused: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
} satisfies Record<DownloadStatus, number>;
const uploadStates = {
  queued: 0,
  preparing: 0,
  uploading: 0,
  finalizing: 0,
  paused: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
} satisfies Record<DriveUploadStatus, number>;
function statusCounts<T extends string>(
  rows: ReadonlyArray<{ status: string }>,
  template: Record<T, number>,
): Record<T, number> {
  const counts = { ...template };
  for (const row of rows) {
    if (typeof row.status !== "string" || !Object.hasOwn(counts, row.status))
      throw new Error("diagnosticsFailed");
    counts[row.status as T]++;
  }
  return counts;
}
const version = z
  .string()
  .max(96)
  .regex(/^(?:v?\d|N-\d)[A-Za-z0-9.+_-]*$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hasControl = (text: string) =>
  Array.from(text).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const pathText = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControl(value));
const binary = z.object({
  available: z.boolean(),
  version: version.nullable(),
  state: z.enum(["ready", "missing", "invalid"]),
});
// Every level strips unknown properties; raw worker output and stored records never cross this boundary.
const snapshotSchema = z.object({
  appVersion: version,
  electronVersion: version,
  nodeVersion: version,
  platform: z.enum([
    "aix",
    "android",
    "darwin",
    "freebsd",
    "linux",
    "netbsd",
    "openbsd",
    "sunos",
    "win32",
  ]),
  architecture: z.enum([
    "arm",
    "arm64",
    "ia32",
    "loong64",
    "mips",
    "mipsel",
    "ppc",
    "ppc64",
    "riscv64",
    "s390",
    "s390x",
    "x64",
  ]),
  schemaVersion: count,
  databasePath: pathText,
  downloadFolder: pathText,
  binaries: z.object({ ytDlp: binary, ffmpeg: binary, ffprobe: binary }),
  driveConnected: z.boolean(),
  browserSession: z.enum(["persistent", "temporary"]),
  activeDownloads: count,
  activeUploads: count,
  availableDiskSpace: count.nullable(),
  settings: z.object({
    language: z.enum(["en", "vi"]),
    theme: z.enum(["dark", "light", "system"]),
    closeBehavior: z.enum(["tray", "exit"]),
    startWithWindows: z.boolean(),
    quality: z.enum(["best", "selected", "2160", "1440", "1080", "720", "480", "audio"]),
    container: z.enum(["mp4", "mkv", "original"]),
    downloadConcurrency: z.number().int().min(1).max(64),
    uploadConcurrency: z.number().int().min(1).max(64),
    autoUpload: z.boolean(),
    deleteLocal: z.enum(["never", "ask", "automatic"]),
  }),
});
const key = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
function inside(root: string, path: string): boolean {
  const remainder = relative(key(root), key(path));
  return (
    remainder === "" ||
    (remainder !== ".." &&
      !remainder.startsWith("..\\") &&
      !remainder.startsWith("../") &&
      !isAbsolute(remainder))
  );
}
export function validateLogId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("invalidInput");
  return id;
}

/** Main-process diagnostics. Paths are accepted only from the native save picker. */
export class DiagnosticsService {
  private closing = false;
  private work: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  constructor(private readonly deps: DiagnosticsDependencies) {}

  private assertOpen(): void {
    if (this.closing) throw new Error("unavailable");
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("unavailable"));
    const result = this.work
      .then(async () => {
        this.assertOpen();
        return operation();
      })
      .catch((error: unknown) => {
        if (error instanceof Error && ["unavailable", "invalidInput"].includes(error.message))
          throw error;
        throw new Error("diagnosticsFailed");
      });
    this.work = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async snapshot(): Promise<DiagnosticsSnapshot> {
    this.assertOpen();
    const value = await this.deps.snapshot();
    this.assertOpen();
    return snapshotSchema.parse(value);
  }
  get(): Promise<DiagnosticsSnapshot> {
    return this.run(() => this.snapshot());
  }
  async logs(filter?: unknown): Promise<DiagnosticLogEntry[]> {
    const checked = validateLogFilter(filter);
    return this.run(async () => {
      const entries = await this.deps.logger.read(checked);
      this.assertOpen();
      return entries;
    });
  }
  async copyLog(id: unknown): Promise<void> {
    const checked = validateLogId(id);
    return this.run(async () => {
      const entry = await this.deps.logger.readEntry(checked);
      this.assertOpen();
      if (!entry) throw new Error("invalidInput");
      await this.deps.writeClipboard(JSON.stringify(entry));
    });
  }
  openLogs(): Promise<void> {
    return this.run(async () => {
      const directory = await this.deps.logger.directory();
      this.assertOpen();
      await this.deps.openPath(directory);
    });
  }
  clearLogs(): Promise<void> {
    return this.run(async () => {
      this.assertOpen();
      await this.deps.logger.clear();
    });
  }
  /** An unresolved native picker must not hold application shutdown open. */
  private choosePath(): Promise<string | null> {
    this.assertOpen();
    return new Promise((resolveChoice, reject) => {
      const stop = () => {
        reject(new Error("unavailable"));
      };
      this.abort.signal.addEventListener("abort", stop, { once: true });
      Promise.resolve()
        .then(() => {
          this.assertOpen();
          return this.deps.chooseExportPath();
        })
        .then(resolveChoice, reject)
        .finally(() => this.abort.signal.removeEventListener("abort", stop));
    });
  }
  private async exportPath(path: string): Promise<string> {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      hasControl(path) ||
      path.startsWith("\\\\?\\") ||
      path.startsWith("\\\\.\\")
    )
      throw new Error("diagnosticsFailed");
    const filename = basename(path);
    if (
      !/\.json$/i.test(filename) ||
      /[:<>"|?*]/.test(filename) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
    )
      throw new Error("diagnosticsFailed");
    const parent = await realpath(dirname(path));
    if (!(await lstat(parent)).isDirectory()) throw new Error("diagnosticsFailed");
    const destination = join(parent, filename);
    for (const protectedPath of [this.deps.userDataDirectory, ...this.deps.protectedDirectories]) {
      const canonical = await realpath(protectedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return resolve(protectedPath);
        throw error;
      });
      if (inside(protectedPath, path) || inside(canonical, destination))
        throw new Error("diagnosticsFailed");
    }
    this.assertOpen();
    return destination;
  }
  exportDiagnostics(): Promise<boolean> {
    return this.run(async () => {
      const selected = await this.choosePath();
      this.assertOpen();
      if (selected === null) return false;
      const path = await this.exportPath(selected);
      const snapshot = await this.snapshot();
      const logs = await this.deps.logger.read();
      this.assertOpen();
      const jobs = this.deps.jobStatuses();
      const jobStatuses = {
        downloads: statusCounts(jobs.downloads, downloadStates),
        uploads: statusCounts(jobs.uploads, uploadStates),
      };
      // Explicit export allowlist: display-only paths, account details and job records are excluded.
      const exported = {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        appVersion: snapshot.appVersion,
        electronVersion: snapshot.electronVersion,
        nodeVersion: snapshot.nodeVersion,
        platform: snapshot.platform,
        architecture: snapshot.architecture,
        schemaVersion: snapshot.schemaVersion,
        binaries: snapshot.binaries,
        driveConnected: snapshot.driveConnected,
        browserSession: snapshot.browserSession,
        activeDownloads:
          jobStatuses.downloads.queued +
          jobStatuses.downloads.analyzing +
          jobStatuses.downloads.downloading +
          jobStatuses.downloads.processing,
        activeUploads:
          jobStatuses.uploads.queued +
          jobStatuses.uploads.preparing +
          jobStatuses.uploads.uploading +
          jobStatuses.uploads.finalizing,
        jobStatuses,
        availableDiskSpace: snapshot.availableDiskSpace,
        settings: snapshot.settings,
        logs,
      };
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let completed = false;
      let created: BigIntStats | undefined;
      try {
        created = await file.stat({ bigint: true });
        this.assertOpen();
        if (!created.isFile() || created.nlink !== 1n || key(await realpath(path)) !== key(path))
          throw new Error("diagnosticsFailed");
        this.assertOpen();
        await file.writeFile(JSON.stringify(exported, null, 2) + "\n", "utf8");
        await file.sync();
        this.assertOpen();
        completed = true;
      } finally {
        try {
          if (!completed && created) {
            // Keep the original handle open through cleanup so its inode cannot be
            // recycled, and never delete a replacement at the native-picked pathname.
            const current = await lstat(path, { bigint: true }).catch(() => undefined);
            if (
              current?.isFile() &&
              !current.isSymbolicLink() &&
              current.nlink === 1n &&
              current.ino === created.ino &&
              current.dev === created.dev &&
              key(await realpath(path)) === key(path)
            )
              await unlink(path).catch(() => {});
          }
        } finally {
          await file.close();
        }
      }
      return true;
    });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.abort.abort();
    await this.work;
  }
}
