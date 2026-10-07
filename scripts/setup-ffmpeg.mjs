import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const origin = "https://www.gyan.dev/ffmpeg/builds";
const validVersion = /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;
const tools = ["ffmpeg.exe", "ffprobe.exe"];
const archiveLimit = 200 * 1024 * 1024;
const executableLimit = 512 * 1024 * 1024;

async function responseFor(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "MediaVault-binary-setup" },
    signal: AbortSignal.timeout(url.endsWith(".zip") ? 15 * 60_000 : 30_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`FFmpeg release download failed (HTTP ${response.status}).`);
  }
  if (
    response.url &&
    (new URL(response.url).protocol !== "https:" ||
      !["www.gyan.dev", "github.com", "release-assets.githubusercontent.com"].includes(
        new URL(response.url).hostname,
      ))
  ) {
    await response.body.cancel();
    throw new Error("Unexpected FFmpeg download location.");
  }
  return response;
}

async function consume(response, limit, consumeChunk) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error("FFmpeg release exceeded its size limit.");
  }
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("FFmpeg release exceeded its size limit.");
      await consumeChunk(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return size;
}

async function smallText(url, fetchImpl) {
  const chunks = [];
  await consume(await responseFor(url, fetchImpl), 1024, (chunk) => {
    chunks.push(chunk);
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function extractTools(archive, stage, root) {
  const zip = await new Promise((resolveZip, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, file) => (error ? reject(error) : resolveZip(file)),
    ),
  );
  const names = new Set(),
    extracted = new Set();
  let total = 0;
  await new Promise((resolveExtract, reject) => {
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (!failed) resolveExtract();
    });
    zip.on("entry", (entry) => {
      void (async () => {
        const name = entry.fileName;
        const segments = name.split("/");
        const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
        total += entry.uncompressedSize;
        if (
          names.size >= 1000 ||
          names.has(name) ||
          !name.startsWith(`${root}/`) ||
          /[\\\x00:\x01-\x1f]/.test(name) ||
          segments.some(
            (segment, index) =>
              segment === "." || segment === ".." || (!segment && index !== segments.length - 1),
          ) ||
          ![0, 0x8000, 0x4000].includes(fileType) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          entry.uncompressedSize > executableLimit ||
          total > 1024 * 1024 * 1024
        )
          throw new Error("Unsafe FFmpeg archive entry.");
        names.add(name);
        const tool = tools.find((item) => name === `${root}/bin/${item}`);
        if (tool) {
          if (name.endsWith("/") || fileType === 0x4000 || entry.uncompressedSize < 2)
            throw new Error("Invalid FFmpeg executable.");
          const source = await new Promise((resolveStream, rejectStream) =>
            zip.openReadStream(entry, (error, stream) =>
              error ? rejectStream(error) : resolveStream(stream),
            ),
          );
          const destination = join(stage, tool);
          await pipeline(source, createWriteStream(destination, { flags: "wx", mode: 0o700 }), {
            signal: AbortSignal.timeout(120_000),
          });
          const file = await open(destination, "r+");
          try {
            const magic = Buffer.alloc(2);
            await file.read(magic, 0, 2, 0);
            if (magic.toString("ascii") !== "MZ") throw new Error("Invalid FFmpeg executable.");
            await file.sync();
          } finally {
            await file.close();
          }
          extracted.add(tool);
        }
        if (!failed) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  if (extracted.size !== tools.length)
    throw new Error("FFmpeg archive is missing required executables.");
}

/** Explicit, Windows x64 setup; never runs on import, startup, or npm install. */
export async function installFFmpeg({
  directory = fileURLToPath(new URL("../resources/bin", import.meta.url)),
  platform = process.platform,
  arch = process.arch,
  version = process.env.MEDIAVAULT_FFMPEG_VERSION || "latest",
  fetchImpl = fetch,
} = {}) {
  if (platform !== "win32" || arch !== "x64")
    throw new Error(
      "Unsupported platform or architecture. Set trusted MEDIAVAULT_FFMPEG_PATH and MEDIAVAULT_FFPROBE_PATH overrides for development.",
    );
  if (version !== "latest" && !validVersion.test(version))
    throw new Error("Invalid FFmpeg release version.");
  const destinationDirectory = resolve(directory);
  for (const tool of tools) {
    try {
      await lstat(join(destinationDirectory, tool));
      throw new Error(
        "FFmpeg tool already exists. Remove it explicitly before running setup again.",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (version === "latest") version = await smallText(`${origin}/release-version`, fetchImpl);
  if (!validVersion.test(version)) throw new Error("Invalid FFmpeg release version.");
  const root = `ffmpeg-${version}-essentials_build`;
  // Gyan links this publisher mirror; use its CDN for the larger archive.
  const url = `https://github.com/GyanD/codexffmpeg/releases/download/${version}/${root}.zip`;
  const checksum = await smallText(`${origin}/packages/${root}.zip.sha256`, fetchImpl);
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) throw new Error("Invalid FFmpeg release checksum.");
  await mkdir(destinationDirectory, { recursive: true });
  const stage = await mkdtemp(join(destinationDirectory, ".ffmpeg-"));
  const installed = [];
  try {
    const archive = join(stage, "release.zip"),
      digest = createHash("sha256");
    const file = await open(archive, "wx", 0o600);
    let size;
    try {
      size = await consume(await responseFor(url, fetchImpl), archiveLimit, async (chunk) => {
        digest.update(chunk);
        await file.writeFile(chunk);
      });
      await file.sync();
    } finally {
      await file.close();
    }
    if (!size || digest.digest("hex") !== checksum.toLowerCase())
      throw new Error("FFmpeg checksum verification failed; nothing was installed.");
    await extractTools(archive, stage, root);
    for (const tool of tools) {
      const destination = join(destinationDirectory, tool);
      // Exclusive hard links atomically publish completed files without replacement.
      await link(join(stage, tool), destination);
      installed.push(tool);
    }
  } catch (error) {
    for (const tool of installed) {
      const destination = join(destinationDirectory, tool),
        source = await lstat(join(stage, tool));
      const current = await lstat(destination).catch(() => undefined);
      if (current?.ino === source.ino && current?.dev === source.dev) await unlink(destination);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return tools.map((tool) => join(destinationDirectory, tool));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installFFmpeg()
    .then(() =>
      console.log(
        "Verified FFmpeg and ffprobe installed in resources/bin from Gyan's release build.",
      ),
    )
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "FFmpeg setup failed.");
      process.exitCode = 1;
    });
}
