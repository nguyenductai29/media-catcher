// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElectronAppUpdater } from "./electron-app-updater";

const mocks = vi.hoisted(() => ({
  signature: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock("./windows-update-signature", () => ({ verifyInstallerSignature: mocks.signature }));
vi.mock("electron-updater", () => ({
  CancellationToken: class {
    cancel() {}
  },
  NsisUpdater: class {
    netSession = { closeAllConnections: mocks.close, webRequest: { onBeforeRequest() {} } };
    checkForUpdates = mocks.check;
    downloadUpdate = mocks.download;
    setFeedURL() {}
    on() {}
    quitAndInstall() {}
  },
}));
vi.mock("electron-updater/out/providers/GitHubProvider", () => ({ GitHubProvider: class {} }));
vi.mock("electron-updater/out/providers/GitHubProvider.js", () => ({ GitHubProvider: class {} }));

const provider = {
  provider: "github" as const,
  owner: "owner",
  repo: "repo",
  publisherName: "Publisher",
};
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("application updater operation cleanup", () => {
  it("keeps cancellation and disposal pending until native signature cleanup has completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mediavault-update-drain-"));
    roots.push(root);
    const file = join(root, "installer.exe");
    const bytes = Buffer.from("owned installer fixture");
    await writeFile(file, bytes);
    mocks.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: "0.1.1",
        files: [
          {
            url: "MediaVault-Setup-0.1.1.exe",
            size: bytes.length,
            sha512: createHash("sha512").update(bytes).digest("base64"),
          },
        ],
      },
    });
    mocks.download.mockResolvedValue([file]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finishCleanup!: () => void;
    mocks.signature.mockImplementation(
      (_file: string, _publisher: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              finishCleanup = () => reject(new Error("cancelled"));
            },
            { once: true },
          );
          entered();
        }),
    );
    const adapter = await createElectronAppUpdater(provider);
    await adapter.check(new AbortController().signal);
    const controller = new AbortController();
    let settled = false;
    const download = adapter.download(controller.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(download).rejects.toThrow("cancelled");
    await started;
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await expect(adapter.check(new AbortController().signal)).rejects.toThrow("updateBusy");
    let disposed = false;
    const disposal = adapter.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    finishCleanup();
    await rejected;
    await disposal;
    expect(settled).toBe(true);
    expect(disposed).toBe(true);
  });
});
