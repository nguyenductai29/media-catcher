// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BinaryService } from "./binary-service";

function fixture() {
  const service = new BinaryService({
    isPackaged: true,
    resourcesPath: "unused",
    appPath: "unused",
  });
  vi.spyOn(service, "getYtDlpPath").mockResolvedValue("yt-dlp.exe");
  return service;
}
function deferred() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

describe("yt-dlp process and update leases", () => {
  it("reserves the executable before asynchronous resolution and holds it until process cleanup", async () => {
    const service = fixture();
    const gate = deferred();
    vi.mocked(service.getYtDlpPath).mockImplementation(async () => {
      await gate.promise;
      return "yt-dlp.exe";
    });
    const running = service.withYtDlp(async () => "finished");
    expect(service.getYtDlpBusy()).toBe(true);
    await expect(service.withYtDlpUpdate(async () => undefined)).rejects.toThrow(/^updateBusy$/);
    gate.release();
    await expect(running).resolves.toBe("finished");
    expect(service.getYtDlpBusy()).toBe(false);
    await expect(service.withYtDlpUpdate(async () => "activated")).resolves.toBe("activated");
  });
  it("blocks new processes during updates, supports abort, and releases after failed activation", async () => {
    const service = fixture();
    const gate = deferred();
    const updating = service.withYtDlpUpdate(async () => {
      await gate.promise;
      throw new Error("updateFailed");
    });
    const outcome = updating.catch((error: Error) => error.message);
    const controller = new AbortController();
    const action = vi.fn(async () => "started");
    const pending = service.withYtDlp(action, controller.signal);
    const cancelled = expect(pending).rejects.toThrow(/^cancelled$/);
    controller.abort();
    await cancelled;
    expect(action).not.toHaveBeenCalled();
    const waiting = service.withYtDlp(action);
    expect(action).not.toHaveBeenCalled();
    gate.release();
    expect(await outcome).toBe("updateFailed");
    await expect(waiting).resolves.toBe("started");
    expect(service.getYtDlpBusy()).toBe(false);
  });
  it("version checks acquire a process lease before resolving the binary", async () => {
    const service = fixture();
    const gate = deferred();
    vi.mocked(service.getYtDlpPath).mockImplementation(async () => {
      await gate.promise;
      throw new Error("binaryMissing");
    });
    const checking = service.checkVersion();
    await expect(service.withYtDlpUpdate(async () => undefined)).rejects.toThrow(/^updateBusy$/);
    gate.release();
    await expect(checking).resolves.toEqual({ available: false, version: null });
    expect(service.getYtDlpBusy()).toBe(false);
  });
});
