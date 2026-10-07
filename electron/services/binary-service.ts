import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { BinaryStatus, ErrorCode } from "../../shared/models";

interface BinaryOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
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
async function terminateProcessTree(child: ChildProcess): Promise<void> {
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

    function fail(code: ErrorCode, kill = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const finish = () => {
        cleanup();
        reject(new Error(code));
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
        const isDrm = /\bDRM\b|digital rights management/i.test(
          Buffer.concat(stderr).toString("utf8"),
        );
        fail(isDrm ? "drmProtected" : "analysisFailed");
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
  constructor(private readonly options: BinaryOptions) {}

  async getYtDlpPath(): Promise<string> {
    const override = this.options.isPackaged ? undefined : process.env["MEDIAVAULT_YTDLP_PATH"];
    const filename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    const binary =
      override ||
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

  async checkVersion(): Promise<BinaryStatus> {
    try {
      const binary = await this.getYtDlpPath();
      const version = (
        await runYtDlpProcess(binary, ["--ignore-config", "--no-plugin-dirs", "--version"], {
          timeout: 5_000,
          maxStdout: 256,
          maxStderr: 4_096,
        })
      ).trim();
      if (!/^\d{4}\.\d{2}\.\d{2}(?:[.\w+-]{0,40})$/.test(version)) {
        return { available: false, version: null };
      }
      return { available: true, version };
    } catch {
      return { available: false, version: null };
    }
  }
}
