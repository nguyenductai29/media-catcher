// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinaryService, runYtDlpProcess } from "./binary-service";
import { YtDlpUpdater } from "./ytdlp-updater";
import { activateUpdate } from "./ytdlp-update-store";

vi.mock("./binary-service", async (original) => ({
  ...(await original<typeof import("./binary-service")>()),
  runYtDlpProcess: vi.fn(),
}));

vi.mock("./ytdlp-update-store", async (original) => {
  const actual = await original<typeof import("./ytdlp-update-store")>();
  return { ...actual, activateUpdate: vi.fn(actual.activateUpdate) };
});
const version = "2026.10.06";
const body = Buffer.from("verified standalone binary fixture");
const digest = createHash("sha256").update(body).digest("hex");
const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
const latest = {
  tag_name: version,
  draft: false,
  prerelease: false,
  assets: [{ name: "yt-dlp.exe", size: body.length, browser_download_url: `${base}/yt-dlp.exe` }],
};
const localVersion = (path: string) =>
  /yt-dlp-(20\d{2}\.\d{2}\.\d{2})-[a-f0-9]{64}\.exe$/.exec(path)?.[1] ?? "2026.08.19";

describe("user-triggered official yt-dlp updater", () => {
  let directory: string;
  let binaries: BinaryService;
  let updater: YtDlpUpdater;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let inspector: ReturnType<typeof vi.fn<(path: string, signal: AbortSignal) => Promise<string>>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-update-"));
    const resources = join(directory, "resources");
    await mkdir(join(resources, "bin"), { recursive: true });
    await writeFile(
      join(resources, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
      "bundled binary",
    );
    binaries = new BinaryService({
      isPackaged: true,
      resourcesPath: resources,
      appPath: directory,
      userDataPath: directory,
    });
    vi.spyOn(binaries, "checkVersion").mockImplementation(async () => ({
      available: true,
      version: localVersion(await binaries.getYtDlpPath()),
    }));
    vi.mocked(runYtDlpProcess)
      .mockReset()
      .mockImplementation(async (path) => localVersion(path));
    fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/latest")) return Response.json(latest);
      if (url.endsWith("/SHA2-256SUMS")) return new Response(`${digest}  yt-dlp.exe\n`);
      if (url === `${base}/yt-dlp.exe`) return new Response(body);
      throw new Error("unexpected URL");
    });
    inspector = vi.fn(async () => version);
    updater = new YtDlpUpdater({
      userDataDirectory: directory,
      binaries,
      fetchImpl: fetcher,
      inspectVersion: inspector,
      platform: "win32",
      arch: "x64",
    });
  });
  afterEach(async () => {
    await updater.shutdown();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  it("initializes without network, fetches only on demand, streams and activates a verified version", async () => {
    expect(await updater.get()).toEqual({
      currentVersion: "2026.08.19",
      latestVersion: null,
      available: false,
      supported: true,
      busy: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await updater.check()).available).toBe(true);
    const state = await updater.update();
    expect(state).toEqual({
      currentVersion: version,
      latestVersion: version,
      available: false,
      supported: true,
      busy: false,
    });
    const active = await binaries.getYtDlpPath();
    expect(active).toBe(join(directory, "bin", `yt-dlp-${version}-${digest}.exe`));
    expect(await readFile(active)).toEqual(body);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.redirect).toBe("manual");
      expect(options?.credentials).toBe("omit");
      expect(options?.headers).not.toHaveProperty("Cookie");
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
    expect((await readdir(join(directory, "bin"))).some((name) => name.includes("partial"))).toBe(
      false,
    );
  });
  it("preserves the previous working executable and pointer after checksum failure", async () => {
    await updater.update();
    const pointer = await readFile(join(directory, "bin/yt-dlp-active.json"));
    const changed = {
      ...latest,
      tag_name: "2026.10.07",
      assets: [
        {
          ...latest.assets[0],
          browser_download_url: `${base.replace(version, "2026.10.07")}/yt-dlp.exe`,
        },
      ],
    };
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith("/latest")
        ? Response.json(changed)
        : String(input).endsWith("/SHA2-256SUMS")
          ? new Response(`${digest}  yt-dlp.exe`)
          : new Response("bad bytes"),
    );
    await expect(updater.update()).rejects.toThrow(/^updateChecksumMismatch$/);
    expect(await readFile(join(directory, "bin/yt-dlp-active.json"))).toEqual(pointer);
    expect((await updater.get()).currentVersion).toBe(version);
  });
  it.each([
    { ...latest, tag_name: "2026.02.30" },
    { ...latest, prerelease: true },
    {
      ...latest,
      assets: [{ ...latest.assets[0], browser_download_url: "https://evil.test/yt-dlp.exe" }],
    },
  ])("rejects malformed or unofficial latest metadata", async (metadata) => {
    fetcher.mockResolvedValue(Response.json(metadata));
    await expect(updater.check()).rejects.toThrow(/^updateFailed$/);
    expect(inspector).not.toHaveBeenCalled();
  });
  it("rejects nonofficial redirect targets before contacting them", async () => {
    fetcher.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://evil.test/binary" } }),
    );
    await expect(updater.check()).rejects.toThrow(/^updateFailed$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("follows bounded official asset redirects and rejects duplicate checksum entries", async () => {
    fetcher.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/latest")) return Response.json(latest);
      if (url === `${base}/SHA2-256SUMS`)
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/official-checksums" },
        });
      return new Response(`${digest}  yt-dlp.exe\n${digest}  yt-dlp.exe`);
    });
    await expect(updater.update()).rejects.toThrow(/^updateFailed$/);
    expect(inspector).not.toHaveBeenCalled();
  });
  it("rejects wrong executable version and interrupted activation without changing the previous pointer", async () => {
    await updater.update();
    const pointer = await readFile(join(directory, "bin/yt-dlp-active.json"));
    const next = "2026.10.07";
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith("/latest")
        ? Response.json({
            ...latest,
            tag_name: next,
            assets: [
              {
                ...latest.assets[0],
                browser_download_url: `${base.replace(version, next)}/yt-dlp.exe`,
              },
            ],
          })
        : String(input).endsWith("/SHA2-256SUMS")
          ? new Response(`${digest}  yt-dlp.exe`)
          : new Response(body),
    );
    inspector.mockResolvedValue("2026.08.19");
    await expect(updater.update()).rejects.toThrow(/^updateFailed$/);
    expect(await readFile(join(directory, "bin/yt-dlp-active.json"))).toEqual(pointer);
    inspector.mockResolvedValue(next);
    vi.mocked(activateUpdate).mockRejectedValueOnce(new Error("simulated rename failure"));
    await expect(updater.update()).rejects.toThrow(/^updateFailed$/);
    expect(await readFile(join(directory, "bin/yt-dlp-active.json"))).toEqual(pointer);
    expect((await updater.update()).currentVersion).toBe(next);
  });
  it("checks while a process is active but rejects update before network access", async () => {
    await updater.initialize();
    let release!: () => void;
    const lease = binaries.withYtDlp(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await updater.check()).busy).toBe(true);
    fetcher.mockClear();
    await expect(updater.update()).rejects.toThrow(/^updateBusy$/);
    expect(fetcher).not.toHaveBeenCalled();
    release();
    await lease;
  });
  it("never downgrades a newer working binary", async () => {
    vi.mocked(binaries.checkVersion).mockResolvedValue({ available: true, version: "2026.10.07" });
    vi.mocked(runYtDlpProcess).mockResolvedValue("2026.10.07");
    expect(await updater.update()).toMatchObject({
      currentVersion: "2026.10.07",
      latestVersion: version,
      available: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(inspector).not.toHaveBeenCalled();
  });
  it("repairs a deleted active executable even when the cached version already equals the release", async () => {
    await updater.update();
    const active = await binaries.getYtDlpPath();
    await rm(active);
    expect(await binaries.getYtDlpPath()).toContain(join("resources", "bin"));
    expect((await updater.get()).available).toBe(false);
    expect((await updater.update()).currentVersion).toBe(version);
    expect(await binaries.getYtDlpPath()).toBe(active);
    expect(await readFile(active)).toEqual(body);
  });
  it("explicit check refreshes the fallback version and re-enables repair after quarantine", async () => {
    await updater.update();
    await rm(await binaries.getYtDlpPath());
    expect(await updater.check()).toMatchObject({
      currentVersion: "2026.08.19",
      latestVersion: version,
      available: true,
    });
    await updater.update();
    expect(await updater.get()).toMatchObject({ currentVersion: version, available: false });
  });
  it("reports a corrupt active executable as fallback while refusing to overwrite its immutable filename", async () => {
    await updater.update();
    const active = await binaries.getYtDlpPath();
    await writeFile(active, "quarantined replacement");
    expect(await updater.check()).toMatchObject({ currentVersion: "2026.08.19", available: true });
    await expect(updater.update()).rejects.toThrow(/^updateChecksumMismatch$/);
    expect(await readFile(active, "utf8")).toBe("quarantined replacement");
    expect(await updater.get()).toMatchObject({ currentVersion: "2026.08.19", available: true });
  });
  it("aborts a stalled binary body on shutdown and removes plaintext staging while retaining bundled fallback", async () => {
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith("/latest")
        ? Response.json(latest)
        : String(input).endsWith("/SHA2-256SUMS")
          ? new Response(`${digest}  yt-dlp.exe`)
          : new Response(
              new ReadableStream({
                pull() {
                  reading();
                  return new Promise(() => {});
                },
              }),
            ),
    );
    const pending = updater.update();
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.race([started, outcome]);
    await updater.shutdown();
    expect(await outcome).toEqual(new Error("cancelled"));
    expect(binaries.getYtDlpBusy()).toBe(false);
    expect(await readdir(join(directory, "bin"))).toEqual([]);
  });
  it("restores a verified pointer after restart and cleans only owned abandoned stages", async () => {
    await updater.update();
    await writeFile(
      join(directory, "bin/.yt-dlp-11111111-1111-4111-8111-111111111111.partial.exe"),
      "interrupted update",
    );
    await writeFile(join(directory, "bin/keep.txt"), "unrelated");
    const restarted = new BinaryService({
      isPackaged: true,
      resourcesPath: join(directory, "resources"),
      appPath: directory,
      userDataPath: directory,
    });
    const path = await restarted.getYtDlpPath();
    expect(await readFile(path)).toEqual(body);
    await updater.shutdown();
    updater = new YtDlpUpdater({
      userDataDirectory: directory,
      binaries,
      fetchImpl: fetcher,
      inspectVersion: inspector,
      platform: "win32",
      arch: "x64",
    });
    await updater.initialize();
    expect(await readFile(join(directory, "bin/keep.txt"), "utf8")).toBe("unrelated");
    expect((await readdir(join(directory, "bin"))).some((name) => name.includes("partial"))).toBe(
      false,
    );
    await writeFile(
      join(directory, "bin/yt-dlp-active.json"),
      JSON.stringify({ version, file: "../../outside.exe", sha256: digest }),
    );
    expect(await restarted.getYtDlpPath()).toContain(join("resources", "bin"));
  });
  it("reports unsupported architectures without network or update writes", async () => {
    await updater.shutdown();
    updater = new YtDlpUpdater({
      userDataDirectory: directory,
      binaries,
      fetchImpl: fetcher,
      platform: "win32",
      arch: "arm64",
    });
    expect((await updater.get()).supported).toBe(false);
    await expect(updater.update()).rejects.toThrow(/^updateUnsupported$/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("disables updates when an explicit development binary would override the installed update", async () => {
    vi.stubEnv("MEDIAVAULT_YTDLP_PATH", join(directory, "custom.exe"));
    try {
      const development = new BinaryService({
        isPackaged: false,
        resourcesPath: directory,
        appPath: directory,
        userDataPath: directory,
      });
      vi.spyOn(development, "checkVersion").mockResolvedValue({
        available: true,
        version: "2026.08.19",
      });
      await updater.shutdown();
      updater = new YtDlpUpdater({
        userDataDirectory: directory,
        binaries: development,
        fetchImpl: fetcher,
        platform: "win32",
        arch: "x64",
      });
      expect(await updater.get()).toMatchObject({ supported: false, currentVersion: "2026.08.19" });
      await expect(updater.update()).rejects.toThrow(/^updateUnsupported$/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
