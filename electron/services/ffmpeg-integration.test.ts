// @vitest-environment node
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BinaryService } from "./binary-service";
import { FFmpegService } from "./ffmpeg-service";
import { runManagedProcess } from "./process-runner";
import { YtDlpService } from "../downloads/ytdlp-service";
import type { DownloadJob } from "../../shared/models";
import type { DownloadProgress } from "../downloads/download-progress";

const executable = (tool: string) =>
  resolve("resources", "bin", `${tool}${process.platform === "win32" ? ".exe" : ""}`);
// Unit tests stay offline; explicit setup makes real binary integration available.
describe.skipIf(!existsSync(executable("ffmpeg")) || !existsSync(executable("ffprobe")))(
  "real FFmpeg media integration (requires setup:ffmpeg)",
  () => {
    let directory: string;
    let input: string;
    const binaries = new BinaryService({
      isPackaged: true,
      resourcesPath: resolve("resources"),
      appPath: "unused",
    });
    const service = new FFmpegService(binaries);
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "mediavault-real-media-"));
      input = join(directory, "fixture.mp4");
      await runManagedProcess(
        await binaries.getFFmpegPath(),
        [
          "-nostdin",
          "-hide_banner",
          "-v",
          "error",
          "-n",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=24",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=44100",
          "-t",
          "3",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "ultrafast",
          "-g",
          "24",
          "-keyint_min",
          "24",
          "-sc_threshold",
          "0",
          "-c:a",
          "aac",
          "-b:a",
          "64k",
          "-movflags",
          "+faststart",
          "-shortest",
          input,
        ],
        { timeout: 30_000, maxStdout: 4096, maxStderr: 65536 },
      );
    }, 35_000);
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("reports real codec versions and probes generated media", async () => {
      const status = await binaries.getStatus();
      expect(status.ffmpeg).toMatchObject({ available: true, state: "ready" });
      expect(status.ffprobe).toMatchObject({ available: true, state: "ready" });
      const probe = await service.probeMedia(input);
      expect(probe).toMatchObject({
        width: 320,
        height: 180,
        videoCodec: "h264",
        audioCodec: "aac",
        hasVideo: true,
        hasAudio: true,
        container: "mp4",
        fileSize: (await stat(input)).size,
      });
      expect(probe.duration).toBeCloseTo(3, 1);
    }, 15_000);
    it("creates a real JPEG without overwriting existing thumbnails", async () => {
      const output = join(directory, "thumbnail.jpg");
      await service.extractThumbnail(input, output, 3);
      const bytes = await readFile(output);
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      await expect(service.extractThumbnail(input, output, 3)).rejects.toThrow(/^probeFailed$/);
      expect(await readFile(output)).toEqual(bytes);
      expect((await readdir(directory)).filter((name) => name.startsWith(".thumbnail"))).toEqual(
        [],
      );
    });
    it.skipIf(!existsSync(executable("yt-dlp")))(
      "downloads real media from a local HTTP fixture and reports structured progress",
      async () => {
        const sourceSize = (await stat(input)).size;
        const server = createServer((request, response) => {
          response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": sourceSize });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const source = createReadStream(input);
          source.on("error", () => response.destroy());
          response.on("close", () => source.destroy());
          source.pipe(response);
        });
        await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("missing fixture server");
          const destination = join(directory, "download");
          await mkdir(destination);
          const job: DownloadJob = {
            id: "fixture",
            sourceUrl: `http://127.0.0.1:${address.port}/fixture.mp4`,
            title: "Local fixture",
            quality: "best",
            container: "mp4",
            destinationDirectory: destination,
            downloadedBytes: 0,
            progress: 0,
            status: "queued",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attempts: 0,
            fromAnalysis: false,
          };
          const progress: DownloadProgress[] = [];
          const output = await new YtDlpService(binaries).download(
            job,
            destination,
            (value) => progress.push(value),
            new AbortController().signal,
          );
          expect((await service.probeMedia(output)).duration).toBeCloseTo(3, 1);
          expect(progress.some((value) => value.downloadedBytes === sourceSize)).toBe(true);
          expect(output.startsWith(destination)).toBe(true);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          );
        }
      },
      30_000,
    );
    it("rejects missing, corrupt and cancelled inputs safely", async () => {
      await expect(service.probeMedia(join(directory, "missing.mp4"))).rejects.toThrow(
        /^fileMissing$/,
      );
      const corrupt = join(directory, "corrupt.mp4");
      await writeFile(corrupt, "invalid media");
      await expect(service.probeMedia(corrupt)).rejects.toThrow(/^probeFailed$/);
      const controller = new AbortController();
      controller.abort();
      await expect(service.probeMedia(input, controller.signal)).rejects.toThrow(/^cancelled$/);
    });
  },
);
