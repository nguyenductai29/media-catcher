import { createHash, randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { YtDlpUpdateState } from "../../shared/models";
import { BinaryService, runYtDlpProcess } from "./binary-service";
import {
  consumeResponse,
  latestRelease,
  officialResponse,
  officialText,
  releaseChecksum,
} from "./ytdlp-official-http";
import {
  activateUpdate,
  cleanupUpdateStages,
  compareVersions,
  MAX_BINARY_BYTES,
  retainVerifiedExecutable,
  throwIfAborted,
  updateDirectory,
  validReleaseVersion,
} from "./ytdlp-update-store";

interface UpdaterOptions {
  userDataDirectory: string;
  binaries: BinaryService;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
  inspectVersion?: (path: string, signal: AbortSignal) => Promise<string>;
}
const publicErrors = new Set([
  "updateFailed",
  "updateBusy",
  "updateChecksumMismatch",
  "updateUnsupported",
  "networkUnavailable",
  "cancelled",
]);

export class YtDlpUpdater {
  private currentVersion: string | null = null;
  private latestVersion: string | null = null;
  private readonly supported: boolean;
  private readonly fetchImpl: typeof fetch;
  private initialized: Promise<void> | undefined;
  private pending: Promise<void> | undefined;
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(private readonly options: UpdaterOptions) {
    this.supported =
      (options.platform ?? process.platform) === "win32" &&
      (options.arch ?? process.arch) === "x64" &&
      !options.binaries.usesYtDlpDevelopmentOverride();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      if (this.closed) return;
      try {
        if (this.supported) await cleanupUpdateStages(this.options.userDataDirectory);
      } catch {
        /* Shipped binary remains usable; update reports a safe failure if storage is inaccessible. */
      }
      const status = await this.options.binaries.checkVersion(this.lifetime.signal);
      this.currentVersion =
        status.available && validReleaseVersion(status.version) ? status.version : null;
    })();
    return this.initialized;
  }

  private snapshot(): YtDlpUpdateState {
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.latestVersion,
      available:
        this.supported &&
        this.latestVersion !== null &&
        (this.currentVersion === null ||
          compareVersions(this.latestVersion, this.currentVersion) > 0),
      supported: this.supported,
      busy: this.pending !== undefined || this.options.binaries.getYtDlpBusy(),
    };
  }

  async get(): Promise<YtDlpUpdateState> {
    await this.initialize();
    return this.snapshot();
  }

  private async operation(
    action: (signal: AbortSignal) => Promise<void>,
    update: boolean,
  ): Promise<YtDlpUpdateState> {
    await this.initialize();
    if (this.closed) throw new Error("cancelled");
    if (!this.supported) throw new Error("updateUnsupported");
    if (this.pending) throw new Error("updateBusy");
    const deadline = AbortSignal.timeout(update ? 180_000 : 30_000);
    const signal = AbortSignal.any([this.lifetime.signal, deadline]);
    const execute = () => action(signal);
    const pending = update ? this.options.binaries.withYtDlpUpdate(execute) : execute();
    this.pending = pending;
    try {
      await pending;
    } catch (error) {
      if (this.lifetime.signal.aborted) throw new Error("cancelled");
      if (deadline.aborted) throw new Error("networkUnavailable");
      throw new Error(
        error instanceof Error && publicErrors.has(error.message) ? error.message : "updateFailed",
      );
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
    return this.snapshot();
  }

  check(): Promise<YtDlpUpdateState> {
    return this.operation(async (signal) => {
      this.latestVersion = (await latestRelease(this.fetchImpl, signal)).version;
      const status = await this.options.binaries.checkVersion(signal);
      throwIfAborted(signal);
      this.currentVersion =
        status.available && validReleaseVersion(status.version) ? status.version : null;
    }, false);
  }

  /** The update already owns the exclusive lease: acquiring a shared version lease would deadlock. */
  private async refreshCurrentDuringUpdate(signal: AbortSignal): Promise<void> {
    try {
      const binary = await this.options.binaries.getYtDlpPath();
      const version = (
        await runYtDlpProcess(binary, ["--ignore-config", "--no-plugin-dirs", "--version"], {
          timeout: 5_000,
          maxStdout: 256,
          maxStderr: 4_096,
          signal,
        })
      ).trim();
      this.currentVersion = validReleaseVersion(version) ? version : null;
    } catch {
      // Discovery validates the active file's checksum and can fall back after quarantine.
      // A missing/invalid current executable must not prevent installing a verified release.
      this.currentVersion = null;
    }
    throwIfAborted(signal);
  }

  update(): Promise<YtDlpUpdateState> {
    return this.operation(async (signal) => {
      const release = await latestRelease(this.fetchImpl, signal);
      this.latestVersion = release.version;
      await this.refreshCurrentDuringUpdate(signal);
      if (this.currentVersion && compareVersions(this.currentVersion, release.version) >= 0) return;
      const expected = releaseChecksum(
        await officialText(this.fetchImpl, release.checksumUrl, signal),
      );
      const directory = await updateDirectory(this.options.userDataDirectory, true);
      const stageName = `.yt-dlp-${randomUUID()}.partial.exe`;
      const stage = join(directory, stageName);
      const handle = await open(stage, "wx", 0o700);
      try {
        const hash = createHash("sha256");
        let bytes: number;
        try {
          bytes = await consumeResponse(
            await officialResponse(this.fetchImpl, release.binaryUrl, signal),
            MAX_BINARY_BYTES,
            signal,
            async (chunk) => {
              hash.update(chunk);
              let offset = 0;
              while (offset < chunk.byteLength) {
                throwIfAborted(signal);
                const written = await handle.write(chunk, offset, chunk.byteLength - offset, null);
                if (!written.bytesWritten) throw new Error("updateFailed");
                offset += written.bytesWritten;
              }
            },
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (hash.digest("hex") !== expected) throw new Error("updateChecksumMismatch");
        if (bytes !== release.size) throw new Error("updateFailed");
        const inspect =
          this.options.inspectVersion ??
          ((path, versionSignal) =>
            runYtDlpProcess(path, ["--ignore-config", "--no-plugin-dirs", "--version"], {
              timeout: 5_000,
              maxStdout: 256,
              maxStderr: 4_096,
              signal: versionSignal,
            }));
        if ((await inspect(stage, signal)).trim() !== release.version)
          throw new Error("updateFailed");
        throwIfAborted(signal);
        const pointer = {
          version: release.version,
          file: `yt-dlp-${release.version}-${expected}.exe`,
          sha256: expected,
        };
        await retainVerifiedExecutable(this.options.userDataDirectory, stageName, pointer, signal);
        await activateUpdate(this.options.userDataDirectory, pointer, signal);
        this.currentVersion = release.version;
      } finally {
        await unlink(stage).catch(() => {});
      }
    }, true);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.allSettled([this.initialized, this.pending]);
  }
}
