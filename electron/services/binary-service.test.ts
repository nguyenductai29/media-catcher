// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinaryService, runYtDlpProcess } from "./binary-service";

describe("BinaryService discovery", () => {
  let directory: string;
  const filename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-binary-"));
    vi.stubEnv("MEDIAVAULT_YTDLP_PATH", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function executable(path: string) {
    await writeFile(path, "fixture executable");
    await chmod(path, 0o755);
    return path;
  }

  it("resolves development and packaged resource directories", async () => {
    await mkdir(join(directory, "resources", "bin"), { recursive: true });
    const expected = await executable(join(directory, "resources", "bin", filename));
    const development = new BinaryService({
      isPackaged: false,
      resourcesPath: "unused",
      appPath: directory,
    });
    const packaged = new BinaryService({
      isPackaged: true,
      resourcesPath: join(directory, "resources"),
      appPath: "unused",
    });
    expect(await development.getYtDlpPath()).toBe(expected);
    expect(await packaged.getYtDlpPath()).toBe(expected);
  });

  it("accepts an absolute development override but ignores it in packaged apps", async () => {
    const custom = await executable(join(directory, filename));
    vi.stubEnv("MEDIAVAULT_YTDLP_PATH", custom);
    expect(
      await new BinaryService({
        isPackaged: false,
        resourcesPath: directory,
        appPath: directory,
      }).getYtDlpPath(),
    ).toBe(custom);
    await expect(
      new BinaryService({
        isPackaged: true,
        resourcesPath: directory,
        appPath: directory,
      }).getYtDlpPath(),
    ).rejects.toThrow(/^binaryMissing$/);
  });

  it("rejects relative overrides, empty executables, and directories", async () => {
    const service = new BinaryService({
      isPackaged: false,
      resourcesPath: directory,
      appPath: directory,
    });
    vi.stubEnv("MEDIAVAULT_YTDLP_PATH", `./${filename}`);
    await expect(service.getYtDlpPath()).rejects.toThrow(/^binaryInvalid$/);
    const empty = join(directory, filename);
    await writeFile(empty, "");
    vi.stubEnv("MEDIAVAULT_YTDLP_PATH", empty);
    await expect(service.getYtDlpPath()).rejects.toThrow(/^binaryInvalid$/);
    vi.stubEnv("MEDIAVAULT_YTDLP_PATH", directory);
    await expect(service.getYtDlpPath()).rejects.toThrow(/^binaryInvalid$/);
  });

  it("reports a missing binary safely without a filesystem error or path", async () => {
    const service = new BinaryService({
      isPackaged: false,
      resourcesPath: directory,
      appPath: directory,
    });
    await expect(service.getYtDlpPath()).rejects.toThrow(/^binaryMissing$/);
    await expect(service.checkVersion()).resolves.toEqual({ available: false, version: null });
  });
});

describe("real analyzer process cancellation", () => {
  it("terminates a launcher and its worker before rejecting cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mediavault-process-tree-"));
    const marker = join(directory, "processes.json");
    const controller = new AbortController();
    let processes: { parent: number; worker: number } | undefined;
    const script = `
      const { spawn } = require('node:child_process');
      const workerScript = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ parent: Number(process.argv[2]), worker: process.pid })); setInterval(() => {}, 1000);";
      // Windows libuv normally owns a kill-on-close job. PyInstaller workers do
      // not, so detach this worker to reproduce that independent lifetime.
      spawn(process.execPath, ['-e', workerScript, process.argv[1], String(process.pid)], { detached: process.platform === 'win32', windowsHide: true, stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;
    const pending = runYtDlpProcess(process.execPath, ["-e", script, marker], {
      signal: controller.signal,
      timeout: 15_000,
      maxStdout: 1024,
      maxStderr: 1024,
    });
    // Attach immediately so a failed launch cannot become an unhandled rejection.
    const outcome = pending.then(
      () => "unexpected-success",
      (error: Error) => error.message,
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await vi.waitFor(
        async () => {
          processes = JSON.parse(await readFile(marker, "utf8")) as {
            parent: number;
            worker: number;
          };
        },
        { timeout: 8_000, interval: 25 },
      );
      expect(alive(processes!.parent)).toBe(true);
      expect(alive(processes!.worker)).toBe(true);
      controller.abort();
      expect(await outcome).toBe("cancelled");
      expect(alive(processes!.parent)).toBe(false);
      expect(alive(processes!.worker)).toBe(false);
    } finally {
      controller.abort();
      await outcome;
      for (const pid of processes ? [processes.worker, processes.parent] : []) {
        if (!alive(pid)) continue;
        if (process.platform === "win32") {
          await promisify(execFile)(
            join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(pid), "/T", "/F"],
            { windowsHide: true },
          ).catch(() => undefined);
        } else {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
