import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DiagnosticLogEntry,
  ErrorCode,
  LogComponent,
  LogEvent,
  LogFilter,
} from "../../shared/models";

const MAX_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 2048;
const MAX_PENDING_APPENDS = 128;
const LOG_NAMES = [
  "mediavault.log",
  "mediavault.log.1",
  "mediavault.log.2",
  "mediavault.log.3",
  "mediavault.log.4",
];
const COMPONENTS = new Set<LogComponent>([
  "download",
  "upload",
  "drive",
  "ipc",
  "startup",
  "shutdown",
  "browser",
  "update",
  "diagnostics",
]);
const EVENTS = new Set<LogEvent>(["authAnalysisRetry", "authDownloadUsed", "cookieCleanupFailed"]);
// A closed vocabulary also sanitizes records written by older application versions.
const CODES = {
  updateFailed: true,
  updateBusy: true,
  updateNotConfigured: true,
  updateChecksumMismatch: true,
  updateUnsupported: true,
  diagnosticsFailed: true,
  startupFailed: true,
  startupUnsupported: true,
  productSettingsFailed: true,
  browserSessionRequired: true,
  storageFailed: true,
  databaseRecoveryFailed: true,
  publicationUnavailable: true,
  invalidUrl: true,
  invalidInput: true,
  unavailable: true,
  navigationFailed: true,
  analysisFailed: true,
  analysisTimeout: true,
  binaryMissing: true,
  binaryInvalid: true,
  drmProtected: true,
  cancelled: true,
  settingsFailed: true,
  databaseFailed: true,
  downloadFailed: true,
  probeFailed: true,
  insufficientSpace: true,
  fileMissing: true,
  fileChanged: true,
  fileAccessDenied: true,
  unsupportedFormat: true,
  driveNotConfigured: true,
  driveNotConnected: true,
  driveAuthFailed: true,
  driveTokenExpired: true,
  driveSecureStorageUnavailable: true,
  drivePermissionDenied: true,
  driveQuotaExceeded: true,
  driveUploadFailed: true,
  driveUploadSessionExpired: true,
  driveFileMissing: true,
  driveVerificationFailed: true,
  driveAccountChanged: true,
  driveAlreadyUploaded: true,
  driveUnavailable: true,
  networkUnavailable: true,
} satisfies Record<ErrorCode, true>;

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
export function validateLogFilter(value: unknown): LogFilter {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidInput");
  const filter = value as Record<string, unknown>;
  if (
    Object.keys(filter).some((key) => key !== "component" && key !== "kind") ||
    ("component" in filter && !COMPONENTS.has(filter.component as LogComponent)) ||
    ("kind" in filter && filter.kind !== "error" && filter.kind !== "event")
  )
    throw new Error("invalidInput");
  return {
    ...(filter.component ? { component: filter.component as LogComponent } : {}),
    ...(filter.kind ? { kind: filter.kind as "error" | "event" } : {}),
  };
}

function parseLine(line: string): Omit<DiagnosticLogEntry, "id"> | undefined {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (
      typeof item.time !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.time) ||
      new Date(item.time).toISOString() !== item.time ||
      !COMPONENTS.has(item.component as LogComponent)
    )
      return;
    const hasCode = item.code !== undefined && item.code !== null;
    const hasEvent = item.event !== undefined && item.event !== null;
    if (hasCode === hasEvent) return;
    if (hasCode && (typeof item.code !== "string" || !Object.hasOwn(CODES, item.code))) return;
    if (hasEvent && (item.component !== "browser" || !EVENTS.has(item.event as LogEvent))) return;
    return {
      time: item.time,
      component: item.component as LogComponent,
      code: hasCode ? (item.code as ErrorCode) : null,
      event: hasEvent ? (item.event as LogEvent) : null,
    };
  } catch {
    return;
  }
}

/** Diagnostic metadata only: never arguments, URLs, cookies, headers, IDs or stderr. */
export class LocalLogger {
  private work: Promise<void> = Promise.resolve();
  private pendingAppends = 0;
  constructor(private readonly userDataDirectory: string) {}

  error(component: LogComponent, code: ErrorCode, _jobId?: string): void {
    this.append({ time: new Date().toISOString(), component, code });
  }
  browserEvent(event: LogEvent): void {
    this.append({ time: new Date().toISOString(), component: "browser", event });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.work.then(operation).catch(() => {
      throw new Error("diagnosticsFailed");
    });
    this.work = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async ownedDirectory(): Promise<string> {
    const root = resolve(this.userDataDirectory);
    const rootInfo = await lstat(root);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !samePath(await realpath(root), root)
    )
      throw new Error("diagnosticsFailed");
    const directory = join(root, "logs");
    await mkdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !samePath(await realpath(directory), directory)
    )
      throw new Error("diagnosticsFailed");
    return directory;
  }
  private async inspect(path: string) {
    const info = await lstat(path, { bigint: true }).catch((error) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (
      info &&
      (!info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        !samePath(await realpath(path), path))
    )
      throw new Error("diagnosticsFailed");
    return info;
  }
  private async files() {
    const directory = await this.ownedDirectory();
    const files = [];
    for (const name of LOG_NAMES) {
      const path = join(directory, name);
      files.push({ name, path, info: await this.inspect(path) });
    }
    return files;
  }
  private append(value: unknown): void {
    // Drop the newest metadata during bursts; diagnostics must not retain unbounded
    // promises or delay shutdown behind an error flood. Normal writes resume after drain.
    if (this.pendingAppends >= MAX_PENDING_APPENDS) return;
    const parsed = parseLine(JSON.stringify(value));
    if (!parsed) return;
    const line =
      JSON.stringify({
        time: parsed.time,
        component: parsed.component,
        ...(parsed.code ? { code: parsed.code } : { event: parsed.event }),
      }) + "\n";
    this.pendingAppends++;
    void this.enqueue(async () => {
      const files = await this.files();
      for (const file of files) {
        if (file.info && file.info.size > BigInt(MAX_BYTES)) {
          await unlink(file.path);
          file.info = undefined;
        }
      }
      const current = files[0]!;
      if (current.info && current.info.size + BigInt(Buffer.byteLength(line)) > BigInt(MAX_BYTES)) {
        if (files[4]!.info) await unlink(files[4]!.path);
        for (let index = 3; index >= 0; index--) {
          if (files[index]!.info) await rename(files[index]!.path, files[index + 1]!.path);
        }
      }
      const file = await open(
        current.path,
        constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const info = await file.stat({ bigint: true });
        const expected = await this.inspect(current.path);
        if (
          !info.isFile() ||
          info.nlink !== 1n ||
          !expected ||
          info.ino !== expected.ino ||
          info.dev !== expected.dev
        )
          throw new Error("diagnosticsFailed");
        await file.writeFile(line, "utf8");
      } finally {
        await file.close();
      }
    })
      .finally(() => {
        this.pendingAppends--;
      })
      .catch(() => {}); // Logging must not interrupt the operation being diagnosed.
  }
  async read(value?: unknown): Promise<DiagnosticLogEntry[]> {
    const filter = validateLogFilter(value);
    return this.readMatching(filter);
  }
  async readEntry(id: string): Promise<DiagnosticLogEntry | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalidInput");
    return (await this.readMatching({}, id))[0];
  }
  private readMatching(filter: LogFilter, wantedId?: string): Promise<DiagnosticLogEntry[]> {
    return this.enqueue(async () => {
      const entries: DiagnosticLogEntry[] = [];
      for (const { path, name, info } of await this.files()) {
        if (!info) continue;
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const actual = await file.stat({ bigint: true });
          if (
            !actual.isFile() ||
            actual.nlink !== 1n ||
            actual.ino !== info.ino ||
            actual.dev !== info.dev ||
            actual.size > BigInt(Number.MAX_SAFE_INTEGER)
          )
            throw new Error("diagnosticsFailed");
          const start = Math.max(0, Number(actual.size) - MAX_BYTES);
          const buffer = Buffer.alloc(Math.min(Number(actual.size), MAX_BYTES));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
          if (start > 0) lines[0] = ""; // Never parse a partial entry at the bounded-tail boundary.
          for (let index = lines.length - 1; index >= 0; index--) {
            const parsed = parseLine(lines[index]!);
            if (
              !parsed ||
              (filter.component && parsed.component !== filter.component) ||
              (filter.kind === "error" && !parsed.code) ||
              (filter.kind === "event" && !parsed.event)
            )
              continue;
            const id = createHash("sha256")
              .update(`${name}:${start}:${index}:${JSON.stringify(parsed)}`)
              .digest("hex");
            if (!wantedId || id === wantedId) entries.push({ id, ...parsed });
          }
        } finally {
          await file.close();
        }
      }
      return entries.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 200);
    });
  }
  clear(): Promise<void> {
    return this.enqueue(async () => {
      for (const file of await this.files()) if (file.info) await unlink(file.path);
    });
  }
  directory(): Promise<string> {
    return this.enqueue(() => this.ownedDirectory());
  }
  flush(): Promise<void> {
    return this.work;
  }
}
