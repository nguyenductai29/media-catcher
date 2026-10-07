// @vitest-environment node
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BinaryService } from "./binary-service";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe.runIf(process.platform === "win32")("direct Settings binary probe shutdown", () => {
  let service: BinaryService;
  let workers: Array<ReturnType<typeof child>>, killers: Array<ReturnType<typeof child>>;
  function child(pid: number) {
    return Object.assign(new EventEmitter(), {
      pid,
      exitCode: null as number | null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
  }
  beforeEach(() => {
    workers = [];
    killers = [];
    vi.clearAllMocks();
    service = new BinaryService({ isPackaged: true, appPath: "unused", resourcesPath: "unused" });
    vi.spyOn(service, "getYtDlpPath").mockResolvedValue("yt-dlp.exe");
    vi.spyOn(service, "getFFmpegPath").mockResolvedValue("ffmpeg.exe");
    vi.spyOn(service, "getFFprobePath").mockResolvedValue("ffprobe.exe");
    vi.mocked(spawn).mockImplementation((executable) => {
      const process = child(workers.length + killers.length + 100);
      if (String(executable).endsWith("taskkill.exe")) killers.push(process);
      else workers.push(process);
      return process as unknown as ChildProcess;
    });
  });
  function finishTermination() {
    for (const worker of workers) {
      worker.exitCode = 1;
      worker.emit("close", 1);
    }
    for (const killer of killers) {
      killer.exitCode = 0;
      killer.emit("close", 0);
    }
  }
  it("aborts all three direct version children and waits for their process-tree cleanup", async () => {
    const checking = service.getStatus();
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    let complete = false;
    const shutdown = service.shutdown().then(() => {
      complete = true;
    });
    await vi.waitFor(() => expect(killers).toHaveLength(3));
    await Promise.resolve();
    expect(complete).toBe(false);
    finishTermination();
    await shutdown;
    await checking;
    expect(complete).toBe(true);
    expect(service.getYtDlpBusy()).toBe(false);
    const count = workers.length;
    await expect(service.checkVersion()).rejects.toThrow("unavailable");
    await expect(service.getStatus()).rejects.toThrow("unavailable");
    expect(workers).toHaveLength(count);
  });
  it("drains a direct yt-dlp status probe independently of download and updater ownership", async () => {
    const checking = service.checkVersion();
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const shutdown = service.shutdown();
    await vi.waitFor(() => expect(killers).toHaveLength(1));
    finishTermination();
    await shutdown;
    expect(await checking).toEqual({ available: false, version: null });
    expect(service.getYtDlpBusy()).toBe(false);
  });
});
