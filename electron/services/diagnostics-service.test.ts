// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsSnapshot } from "../../shared/models";
import { LocalLogger } from "./local-logger";
import { DiagnosticsService } from "./diagnostics-service";

describe("private local diagnostics", () => {
  let root: string, profile: string, install: string, output: string;
  let logger: LocalLogger, service: DiagnosticsService, data: DiagnosticsSnapshot;
  const choose = vi.fn<() => Promise<string | null>>();
  const clipboard = vi.fn<(text: string) => void>();
  const openPath = vi.fn<(path: string) => Promise<void>>();
  const snapshot = vi.fn<() => Promise<DiagnosticsSnapshot>>();
  const jobStatuses = vi.fn(() => ({
    downloads: [
      { status: "queued", title: "private-title", url: "https://private.invalid" },
      { status: "downloading" },
      { status: "paused" },
      { status: "completed" },
      { status: "failed" },
    ],
    uploads: [{ status: "paused", sessionUrl: "private-session" }],
  }));
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "mv-diagnostics-"));
    profile = join(root, "private-profile");
    install = join(root, "installation");
    output = join(root, "diagnostics.json");
    await mkdir(profile);
    await mkdir(install);
    const binary = { available: true, version: "9.0.2-full_build", state: "ready" as const };
    data = {
      appVersion: "0.1.0",
      electronVersion: "44.6.0",
      nodeVersion: "24.21.0",
      platform: "win32",
      architecture: "x64",
      schemaVersion: 3,
      databasePath: join(profile, "private.db"),
      downloadFolder: join(root, "private-downloads"),
      binaries: {
        ytDlp: { available: false, version: null, state: "missing" },
        ffmpeg: binary,
        ffprobe: binary,
      },
      driveConnected: false,
      browserSession: "persistent",
      activeDownloads: 2,
      activeUploads: 0,
      availableDiskSpace: 1234567,
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
    logger = new LocalLogger(profile);
    choose.mockResolvedValue(output);
    openPath.mockResolvedValue();
    snapshot.mockImplementation(async () => data);
    service = new DiagnosticsService({
      snapshot,
      jobStatuses,
      logger,
      userDataDirectory: profile,
      protectedDirectories: [install],
      chooseExportPath: choose,
      openPath,
      writeClipboard: clipboard,
    });
  });
  afterEach(async () => {
    await service.shutdown();
    await logger.flush();
    await rm(root, { recursive: true, force: true });
  });
  it("reconstructs the display snapshot and exports only explicit safe fields and sanitized logs", async () => {
    Object.assign(data, {
      token: "secret-token",
      media: [{ title: "private-title", url: "https://private.invalid" }],
      accountEmail: "private@example.invalid",
    });
    Object.assign(data.settings, {
      authorization: "secret-header",
      directory: "private-directory",
    });
    Object.assign(data.binaries.ffmpeg, { path: "private-binary-path", stderr: "secret-stderr" });
    await mkdir(join(profile, "logs"));
    await writeFile(
      join(profile, "logs", "mediavault.log"),
      JSON.stringify({
        time: "2026-01-01T00:00:00.000Z",
        component: "download",
        code: "downloadFailed",
        jobId: "private-job",
        cookie: "secret-cookie",
      }) + "\n",
    );
    const displayed = await service.get();
    expect(displayed.databasePath).toBe(data.databasePath);
    expect(displayed).not.toHaveProperty("token");
    expect(displayed.settings).not.toHaveProperty("authorization");
    expect(await service.exportDiagnostics()).toBe(true);
    const text = await readFile(output, "utf8");
    expect(text).not.toMatch(
      /secret|private|databasePath|downloadFolder|accountEmail|jobId|authorization|stderr/,
    );
    const exported = JSON.parse(text);
    expect(exported.appVersion).toBe("0.1.0");
    expect(exported.activeDownloads).toBe(2);
    expect(exported.binaries.ytDlp.state).toBe("missing");
    expect(exported.logs).toHaveLength(1);
    expect(exported.jobStatuses).toEqual({
      downloads: {
        queued: 1,
        analyzing: 0,
        downloading: 1,
        processing: 0,
        paused: 1,
        completed: 1,
        failed: 1,
        cancelled: 0,
      },
      uploads: {
        queued: 0,
        preparing: 0,
        uploading: 0,
        finalizing: 0,
        paused: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    });
  });
  it("refuses unknown job status text before creating an export file", async () => {
    jobStatuses.mockReturnValueOnce({
      downloads: [{ status: "private-secret-status" }],
      uploads: [],
    });
    await expect(service.exportDiagnostics()).rejects.toThrow("diagnosticsFailed");
    expect(await readdir(root)).not.toContain("diagnostics.json");
  });
  it("rejects malformed snapshot values instead of exporting unexpected text", async () => {
    data.binaries.ffmpeg.version = "https://private.invalid/?token=secret";
    await expect(service.get()).rejects.toThrow("diagnosticsFailed");
    await expect(service.exportDiagnostics()).rejects.toThrow("diagnosticsFailed");
    expect(await readdir(root)).not.toContain("diagnostics.json");
  });
  it("cancels native export without taking a snapshot or writing any file", async () => {
    choose.mockResolvedValue(null);
    expect(await service.exportDiagnostics()).toBe(false);
    expect(snapshot).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(expect.not.arrayContaining(["diagnostics.json"]));
  });
  it("never overwrites an existing file, even a native-picked JSON file", async () => {
    await writeFile(output, "keep user document");
    await expect(service.exportDiagnostics()).rejects.toThrow("diagnosticsFailed");
    expect(await readFile(output, "utf8")).toBe("keep user document");
  });
  it("rejects profile/install destinations and paths redirected into protected data", async () => {
    const redirected = join(root, "redirect");
    await symlink(profile, redirected, "junction");
    for (const path of [
      join(profile, "report.json"),
      join(install, "report.json"),
      join(redirected, "report.json"),
      join(root, "report.db"),
      "relative.json",
    ]) {
      choose.mockResolvedValue(path);
      await expect(service.exportDiagnostics()).rejects.toThrow("diagnosticsFailed");
    }
    expect(await readdir(profile)).not.toContain("report.json");
    expect(await readdir(install)).not.toContain("report.json");
  });
  it("copies only a selected current sanitized entry and refuses arbitrary renderer text or stale IDs", async () => {
    logger.error("download", "downloadFailed", "private-job-id");
    const entries = await service.logs();
    await service.copyLog(entries[0]!.id);
    expect(JSON.parse(clipboard.mock.calls[0]![0])).toEqual(entries[0]);
    expect(clipboard.mock.calls[0]![0]).not.toMatch(/private|jobId/);
    for (const id of ["secret-cookie", { id: entries[0]!.id }, "a".repeat(64)])
      await expect(service.copyLog(id)).rejects.toThrow("invalidInput");
    expect(clipboard).toHaveBeenCalledTimes(1);
    await service.clearLogs();
    await expect(service.copyLog(entries[0]!.id)).rejects.toThrow("invalidInput");
  });
  it("can copy an entry selected through a filter even when 200 newer entries have another kind", async () => {
    await mkdir(join(profile, "logs"));
    const rows = [
      { time: "2026-01-01T00:00:00.000Z", component: "download", code: "downloadFailed" },
      ...Array.from({ length: 205 }, (_, index) => ({
        time: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
        component: "browser",
        event: "authAnalysisRetry",
      })),
    ];
    await writeFile(
      join(profile, "logs", "mediavault.log"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const selected = (await service.logs({ kind: "error" }))[0]!;
    await service.copyLog(selected.id);
    expect(JSON.parse(clipboard.mock.calls[0]![0])).toEqual(selected);
  });
  it("opens only the owned log directory and preserves unrelated files when clearing", async () => {
    logger.error("startup", "databaseFailed");
    await logger.flush();
    await writeFile(join(profile, "logs", "unrelated.txt"), "keep");
    await service.openLogs();
    expect(openPath).toHaveBeenCalledExactlyOnceWith(join(profile, "logs"));
    await service.clearLogs();
    expect(await service.logs()).toEqual([]);
    expect(await readFile(join(profile, "logs", "unrelated.txt"), "utf8")).toBe("keep");
  });
  it("does not open a redirected log directory", async () => {
    await symlink(install, join(profile, "logs"), "junction");
    await expect(service.openLogs()).rejects.toThrow("diagnosticsFailed");
    expect(openPath).not.toHaveBeenCalled();
  });
  it("lets shutdown cancel an unresolved native picker and ignores its later result", async () => {
    let finish!: (path: string) => void;
    choose.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const exporting = service.exportDiagnostics();
    const rejected = expect(exporting).rejects.toThrow("unavailable");
    await vi.waitFor(() => expect(choose).toHaveBeenCalled());
    await service.shutdown();
    await rejected;
    finish(output);
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();
    expect(await readdir(root)).not.toContain("diagnostics.json");
    await expect(service.get()).rejects.toThrow("unavailable");
  });
  it("drains an in-progress snapshot before shutdown resolves and suppresses late results", async () => {
    let finish!: (value: DiagnosticsSnapshot) => void;
    snapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const getting = service.get();
    const rejected = expect(getting).rejects.toThrow("unavailable");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    let closed = false;
    const closing = service.shutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish(data);
    await closing;
    await rejected;
  });
});
