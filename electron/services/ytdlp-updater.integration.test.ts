// @vitest-environment node
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BinaryService } from "./binary-service";
import { YtDlpUpdater } from "./ytdlp-updater";

describe("real packaged yt-dlp update and restart", () => {
  it.skipIf(process.platform !== "win32")(
    "streams the pinned EXE and validates it with the actual native process",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "mediavault-real-update-"));
      const binary = resolve("resources/bin/yt-dlp.exe");
      const manifest = JSON.parse(await readFile("resources/notices/binaries.json", "utf8")) as {
        binaries: { file: string; version: string; sha256: string }[];
      };
      const release = manifest.binaries.find((entry) => entry.file === "yt-dlp.exe");
      expect(release?.version).toBe("2026.08.19");
      if (!release) throw new Error("missing pinned fixture");
      const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${release.version}`;
      const size = (await stat(binary)).size;
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/latest"))
          return Response.json({
            tag_name: release.version,
            draft: false,
            prerelease: false,
            assets: [{ name: "yt-dlp.exe", size, browser_download_url: `${base}/yt-dlp.exe` }],
          });
        if (url === `${base}/SHA2-256SUMS`) return new Response(`${release.sha256}  yt-dlp.exe\n`);
        if (url === `${base}/yt-dlp.exe`)
          return new Response(
            Readable.toWeb(
              createReadStream(binary, { highWaterMark: 64 * 1024 }),
            ) as ReadableStream<Uint8Array>,
          );
        throw new Error("unexpected endpoint");
      });
      const options = {
        isPackaged: true,
        resourcesPath: join(directory, "missing-shipped"),
        appPath: directory,
        userDataPath: directory,
      };
      const binaries = new BinaryService(options);
      const updater = new YtDlpUpdater({
        userDataDirectory: directory,
        binaries,
        fetchImpl: fetcher,
      });
      try {
        expect((await updater.get()).currentVersion).toBeNull();
        expect((await updater.update()).currentVersion).toBe(release.version);
        // The direct native version probe must settle while the exclusive updater lease is held.
        expect((await updater.update()).currentVersion).toBe(release.version);
        expect(fetcher).toHaveBeenCalledTimes(4); // First metadata/checksum/EXE, then metadata only.
        expect(await binaries.checkVersion()).toEqual({
          available: true,
          version: release.version,
        });
        const restarted = new BinaryService(options);
        expect(await restarted.checkVersion()).toEqual({
          available: true,
          version: release.version,
        });
        expect(await restarted.getYtDlpPath()).toBe(
          join(directory, "bin", `yt-dlp-${release.version}-${release.sha256}.exe`),
        );
      } finally {
        await updater.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
