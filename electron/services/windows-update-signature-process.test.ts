// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "./binary-service";
import { verifyInstallerSignature } from "./windows-update-signature";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./binary-service", () => ({ terminateProcessTree: vi.fn(async () => {}) }));
const path = "C:\\Updates\\Tiếng Việt ' $(literal).exe";
const report = JSON.stringify({ status: 0, path, subject: "CN=Example", commonName: "Example" });
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough };
beforeEach(() => {
  vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
afterEach(() => {
  vi.useRealTimers();
});
describe.runIf(process.platform === "win32")("bounded native signature process", () => {
  it("passes the literal filename only through environment data and uses a hidden shell-free system executable", async () => {
    const pending = verifyInstallerSignature(path, "Example", new AbortController().signal);
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(String(file)).toMatch(/Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe$/i);
    expect(options).toMatchObject({
      shell: false,
      windowsHide: true,
      env: { MEDIAVAULT_SIGNATURE_FILE: path },
    });
    expect(args).not.toContain(path);
    child.stdout.end(report);
    child.emit("close", 0);
    await expect(pending).resolves.toBeUndefined();
  });
  it.each(["missing", "empty", "stderr", "nonzero"])(
    "fails closed when PowerShell returns %s verification",
    async (mode) => {
      const pending = verifyInstallerSignature(path, "Example", new AbortController().signal);
      const rejected = expect(pending).rejects.toThrow("updateFailed");
      if (mode === "missing")
        child.emit(
          "error",
          Object.assign(new Error("private verifier detail"), { code: "ENOENT" }),
        );
      else {
        if (mode === "stderr") {
          child.stderr.write("private verifier detail");
          child.stdout.write(report);
        }
        child.emit("close", mode === "nonzero" ? 1 : 0);
      }
      await rejected;
    },
  );
  it("kills the verifier on excessive output without accepting the first valid JSON report", async () => {
    const pending = verifyInstallerSignature(path, "Example", new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("updateFailed");
    child.stdout.write(report + " ".repeat(16 * 1024));
    await rejected;
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
  });
  it("waits for owned process tree termination before rejecting cancellation", async () => {
    let finish!: () => void;
    vi.mocked(terminateProcessTree).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = verifyInstallerSignature(path, "Example", controller.signal);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await rejected;
    expect(child.stdout.destroyed).toBe(true);
  });
  it("bounds a stalled verifier by its deadline", async () => {
    vi.useFakeTimers();
    const pending = verifyInstallerSignature(path, "Example", new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("updateFailed");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
  });
});
