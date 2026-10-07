// @vitest-environment node
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsSnapshot } from "../../shared/models";
import { DiagnosticsService } from "./diagnostics-service";
import { LocalLogger } from "./local-logger";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

describe("diagnostics exact file ownership", () => {
  let root: string, logger: LocalLogger, service: DiagnosticsService | undefined;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(actual.open);
    vi.mocked(lstat).mockImplementation(actual.lstat);
    root = await mkdtemp(join(tmpdir(), "mv-diag-identity-"));
    logger = new LocalLogger(root);
  });
  afterEach(async () => {
    await service?.shutdown();
    service = undefined;
    await logger.flush();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  it("does not read or append a replaced log when inode numbers collide as JavaScript numbers", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const path = join(root, "logs", "mediavault.log");
    await mkdir(join(root, "logs"));
    const original =
      JSON.stringify({
        time: "2026-01-01T00:00:00.000Z",
        component: "download",
        code: "downloadFailed",
      }) + "\n";
    await writeFile(path, original);
    vi.mocked(lstat).mockImplementation((async (target, options) => {
      const info = await actual.lstat(target, options);
      if (String(target) === path)
        Object.assign(info, {
          ino: options?.bigint ? 9007199254740992n : Number(9007199254740992n),
        });
      return info;
    }) as typeof lstat);
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === path) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation((async (options) => {
          const info = await stat(options);
          Object.assign(info, {
            ino: options?.bigint ? 9007199254740993n : Number(9007199254740993n),
          });
          return info;
        }) as typeof handle.stat);
      }
      return handle;
    });
    await expect(logger.read()).rejects.toThrow("diagnosticsFailed");
    logger.error("download", "downloadFailed");
    await logger.flush();
    expect(await readFile(path, "utf8")).toBe(original);
  });
  it("preserves a replacement at the export pathname when writing the originally created file fails", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const profile = join(root, "profile");
    await mkdir(profile);
    const output = join(root, "report.json");
    let replaced = false;
    vi.mocked(lstat).mockImplementation((async (target, options) => {
      const info = await actual.lstat(target, options);
      if (String(target) === output && replaced)
        Object.assign(info, {
          ino: options?.bigint ? 9007199254740993n : Number(9007199254740993n),
        });
      return info;
    }) as typeof lstat);
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]) === output) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation((async (options) => {
          const info = await stat(options);
          Object.assign(info, {
            ino: options?.bigint ? 9007199254740992n : Number(9007199254740992n),
          });
          return info;
        }) as typeof handle.stat);
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          await rename(output, join(root, "original-created-file.json"));
          await writeFile(output, "replacement user file");
          replaced = true;
          throw new Error("write failed");
        });
      }
      return handle;
    });
    const binary = { available: false, version: null, state: "missing" as const };
    const snapshot: DiagnosticsSnapshot = {
      appVersion: "0.1.0",
      electronVersion: "44.6.0",
      nodeVersion: "24.21.0",
      platform: "win32",
      architecture: "x64",
      schemaVersion: 3,
      databasePath: join(profile, "db"),
      downloadFolder: root,
      binaries: { ytDlp: binary, ffmpeg: binary, ffprobe: binary },
      driveConnected: false,
      browserSession: "temporary",
      activeDownloads: 0,
      activeUploads: 0,
      availableDiskSpace: null,
      settings: {
        language: "en",
        theme: "dark",
        closeBehavior: "tray",
        startWithWindows: false,
        quality: "best",
        container: "mp4",
        downloadConcurrency: 2,
        uploadConcurrency: 2,
        autoUpload: false,
        deleteLocal: "never",
      },
    };
    service = new DiagnosticsService({
      snapshot: async () => snapshot,
      jobStatuses: () => ({ downloads: [], uploads: [] }),
      logger,
      userDataDirectory: profile,
      protectedDirectories: [],
      chooseExportPath: async () => output,
      openPath: async () => {},
      writeClipboard: () => {},
    });
    await expect(service.exportDiagnostics()).rejects.toThrow("diagnosticsFailed");
    expect(replaced).toBe(true);
    expect(await readFile(output, "utf8")).toBe("replacement user file");
  });
});
