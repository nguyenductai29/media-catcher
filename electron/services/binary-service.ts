import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { BinaryDetail, BinaryStatus, BinaryStatuses, ErrorCode } from "../../shared/models";
import { classifyProcessFailure } from "./process-failure";
import { readActiveUpdate } from "./ytdlp-update-store";

interface BinaryOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  userDataPath?: string;
}

interface ProcessOptions {
  timeout: number;
  maxStdout: number;
  maxStderr: number;
  signal?: AbortSignal | undefined;
}

function systemCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function killDirect(child: ChildProcess) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* The process may already have exited. */
  }
}

/** Terminate the worker before its launcher, which is needed by one-file yt-dlp builds. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    killDirect(child);
    return;
  }
  let closed = child.exitCode !== null || child.signalCode !== null;
  const markClosed = () => {
    closed = true;
  };
  child.once("close", markClosed);
  if (process.platform === "win32") {
    const killedTree = await new Promise<boolean>((resolve) => {
      let killer: ChildProcess;
      try {
        // Use the system executable, never PATH lookup or a shell command string.
        killer = spawn(
          join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
      } catch {
        resolve(false);
        return;
      }
      let finished = false;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(success);
      };
      const timer = setTimeout(() => {
        killDirect(killer);
        finish(false);
      }, 3_000);
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0));
    });
    if (!killedTree) killDirect(child);
  } else {
    // The analyzer starts its own process group; its workers inherit that group.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      killDirect(child);
    }
  }
  if (!closed) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        child.removeListener("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      child.once("close", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }
  child.removeListener("close", markClosed);
}

/** A bounded process boundary shared by version checks and metadata analysis. */
export function runYtDlpProcess(
  binary: string,
  args: string[],
  options: ProcessOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.end();
    } catch (error) {
      reject(new Error(systemCode(error) === "ENOENT" ? "binaryMissing" : "binaryInvalid"));
      return;
    }

    let settled = false;
    let stdoutSize = 0;
    let stderrSize = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => fail("analysisTimeout", true), options.timeout);

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.stdout.removeListener("data", output);
      child.stderr.removeListener("data", diagnostic);
      child.removeListener("close", closed);
      // Keep the error handler until close so late spawn/kill errors stay handled.
      child.once("close", () => child.removeListener("error", launchError));
      child.stdout.destroy();
      child.stderr.destroy();
      stdout.length = 0;
      stderr.length = 0;
    }

    function fail(code: ErrorCode | Error, kill = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const finish = () => {
        cleanup();
        reject(code instanceof Error ? code : new Error(code));
      };
      if (kill) void terminateProcessTree(child).then(finish, finish);
      else finish();
    }

    function abort() {
      fail("cancelled", true);
    }
    function launchError(error: unknown) {
      fail(systemCode(error) === "ENOENT" ? "binaryMissing" : "binaryInvalid");
    }
    function output(chunk: Buffer | string) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutSize += bytes.length;
      if (stdoutSize > options.maxStdout) {
        fail("analysisFailed", true);
        return;
      }
      stdout.push(bytes);
    }
    function diagnostic(chunk: Buffer | string) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrSize += bytes.length;
      if (stderrSize > options.maxStderr) {
        fail("analysisFailed", true);
        return;
      }
      stderr.push(bytes);
    }
    function closed(code: number | null) {
      if (settled) return;
      if (code !== 0) {
        fail(classifyProcessFailure(Buffer.concat(stderr).toString("utf8"), "analysisFailed"));
        child.removeListener("error", launchError);
        return;
      }
      const result = Buffer.concat(stdout).toString("utf8");
      settled = true;
      cleanup();
      child.removeListener("error", launchError);
      resolve(result);
    }

    child.stdout.on("data", output);
    child.stderr.on("data", diagnostic);
    child.once("error", launchError);
    child.once("close", closed);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export class BinaryService {
  private ytDlpLeases = 0;
  private updateBarrier: Promise<void> | undefined;
  private readonly probeAbort = new AbortController();
  private readonly probes = new Set<Promise<unknown>>();
  private probesClosed = false;
  constructor(private readonly options: BinaryOptions) {}

  private trackedProbe<T>(
    action: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    if (this.probesClosed) return Promise.reject(new Error("unavailable"));
    const signal = caller
      ? AbortSignal.any([caller, this.probeAbort.signal])
      : this.probeAbort.signal;
    // Start synchronously so yt-dlp reserves its lease before another IPC turn can update it.
    const task = action(signal);
    this.probes.add(task);
    void task.finally(() => this.probes.delete(task)).catch(() => {});
    return task;
  }

  /** Direct Settings/diagnostics probes have their own lifecycle; download leases stay owned by their managers. */
  async shutdown(): Promise<void> {
    this.probesClosed = true;
    this.probeAbort.abort();
    await Promise.allSettled([...this.probes]);
  }

  getYtDlpBusy(): boolean {
    return this.ytDlpLeases > 0 || this.updateBarrier !== undefined;
  }

  usesYtDlpDevelopmentOverride(): boolean {
    return !this.options.isPackaged && !!process.env["MEDIAVAULT_YTDLP_PATH"];
  }

  /** Reserve before path resolution; release only after the child and its workers settle. */
  async withYtDlp<T>(action: (binary: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.updateBarrier) {
      const barrier = this.updateBarrier;
      await new Promise<void>((resolveWait, reject) => {
        const abort = () => {
          signal?.removeEventListener("abort", abort);
          reject(new Error("cancelled"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        void barrier.then(() => {
          signal?.removeEventListener("abort", abort);
          resolveWait();
        });
      });
    }
    if (signal?.aborted) throw new Error("cancelled");
    this.ytDlpLeases++;
    try {
      const binary = await this.getYtDlpPath();
      if (signal?.aborted) throw new Error("cancelled");
      return await action(binary);
    } finally {
      this.ytDlpLeases--;
    }
  }

  /** Atomic shared/exclusive decision on the Main event loop. Never replace a leased binary. */
  async withYtDlpUpdate<T>(action: () => Promise<T>): Promise<T> {
    if (this.getYtDlpBusy()) throw new Error("updateBusy");
    let release!: () => void;
    this.updateBarrier = new Promise<void>((resolveWait) => {
      release = resolveWait;
    });
    try {
      return await action();
    } finally {
      this.updateBarrier = undefined;
      release();
    }
  }

  async getYtDlpPath(): Promise<string> {
    return this.getPath("yt-dlp", "MEDIAVAULT_YTDLP_PATH");
  }

  async getFFmpegPath(): Promise<string> {
    return this.getPath("ffmpeg", "MEDIAVAULT_FFMPEG_PATH");
  }

  async getFFprobePath(): Promise<string> {
    return this.getPath("ffprobe", "MEDIAVAULT_FFPROBE_PATH");
  }

  private async getPath(name: string, environment: string): Promise<string> {
    const override = this.options.isPackaged ? undefined : process.env[environment];
    const active =
      name === "yt-dlp" && !override && this.options.userDataPath
        ? await readActiveUpdate(this.options.userDataPath)
        : undefined;
    const filename = process.platform === "win32" ? `${name}.exe` : name;
    const binary =
      override ||
      active ||
      (this.options.isPackaged
        ? join(this.options.resourcesPath, "bin", filename)
        : join(this.options.appPath, "resources", "bin", filename));
    if (
      !isAbsolute(binary) ||
      (process.platform === "win32" && extname(binary).toLowerCase() !== ".exe")
    ) {
      throw new Error("binaryInvalid");
    }
    try {
      const info = await stat(binary);
      if (!info.isFile() || info.size === 0) throw new Error("binaryInvalid");
      await access(binary, constants.X_OK);
      return binary;
    } catch (error) {
      throw new Error(systemCode(error) === "ENOENT" ? "binaryMissing" : "binaryInvalid");
    }
  }

  checkVersion(signal?: AbortSignal): Promise<BinaryStatus> {
    return this.trackedProbe((activeSignal) => this.checkVersionUsing(activeSignal), signal);
  }
  private async checkVersionUsing(signal: AbortSignal): Promise<BinaryStatus> {
    try {
      const version = (
        await this.withYtDlp(
          (binary) =>
            runYtDlpProcess(binary, ["--ignore-config", "--no-plugin-dirs", "--version"], {
              timeout: 5_000,
              maxStdout: 256,
              maxStderr: 4_096,
              signal,
            }),
          signal,
        )
      ).trim();
      if (!/^\d{4}\.\d{2}\.\d{2}(?:[.\w+-]{0,40})$/.test(version)) {
        return { available: false, version: null };
      }
      return { available: true, version };
    } catch {
      return { available: false, version: null };
    }
  }

  getStatus(): Promise<BinaryStatuses> {
    return this.trackedProbe((signal) => this.getStatusUsing(signal));
  }
  private async getStatusUsing(signal: AbortSignal): Promise<BinaryStatuses> {
    const inspect = async (tool: "yt-dlp" | "ffmpeg" | "ffprobe"): Promise<BinaryDetail> => {
      try {
        const run = (binary: string) =>
          runYtDlpProcess(
            binary,
            tool === "yt-dlp" ? ["--ignore-config", "--no-plugin-dirs", "--version"] : ["-version"],
            {
              timeout: 5_000,
              maxStdout: 32_768,
              maxStderr: 4_096,
              signal,
            },
          );
        const output =
          tool === "yt-dlp"
            ? await this.withYtDlp(run, signal)
            : await run(await (tool === "ffmpeg" ? this.getFFmpegPath() : this.getFFprobePath()));
        const version =
          tool === "yt-dlp"
            ? output.trim()
            : new RegExp(`^${tool} version ([A-Za-z0-9._+-]{1,100})(?:\\s|$)`).exec(output)?.[1];
        if (
          !version ||
          (tool === "yt-dlp" && !/^\d{4}\.\d{2}\.\d{2}(?:[.\w+-]{0,40})$/.test(version))
        )
          throw new Error("binaryInvalid");
        return { available: true, version, state: "ready" };
      } catch (error) {
        return {
          available: false,
          version: null,
          state:
            error instanceof Error && error.message === "binaryMissing" ? "missing" : "invalid",
        };
      }
    };
    const [ytDlp, ffmpeg, ffprobe] = await Promise.all([
      inspect("yt-dlp"),
      inspect("ffmpeg"),
      inspect("ffprobe"),
    ]);
    return { ytDlp, ffmpeg, ffprobe };
  }
}
