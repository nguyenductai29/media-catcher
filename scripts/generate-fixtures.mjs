import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const MAX_ASSET_BYTES = 3 * 1024 ** 3;
export const fixtureAssetName =
  /^(?:clip-(?:10|60)s\.mp4|large\.mp4|hls\/(?:index\.m3u8|segment-\d{3,5}\.ts)|dash\/(?:index\.mpd|init-\d+\.m4s|chunk-\d+-\d{5}\.m4s))$/;
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = () => new Error("Invalid or modified MediaVault fixture directory.");

export async function canonicalFixtureDirectory(input, create = false) {
  if (typeof input !== "string" || !input || /[\p{Cc}]/u.test(input) || input.startsWith("\\\\"))
    throw fail();
  const absolute = resolve(input);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
  }
  if (!samePath(await realpath(absolute), absolute)) throw fail();
  return absolute;
}

export function parseGeneratorArguments(args) {
  const options = {
    outputDirectory: join(repository, "artifacts", "fixtures"),
    dash: false,
    largeMiB: 0,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error("Duplicate fixture option.");
    seen.add(argument);
    if (argument === "--help") options.help = true;
    else if (argument === "--dash") options.dash = true;
    else if (argument === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--output requires a directory.");
      options.outputDirectory = resolve(value);
    } else if (argument === "--large-mib") {
      const value = args[++index];
      if (!/^[0-9]+$/.test(value ?? "") || Number(value) < 16 || Number(value) > 2048)
        throw new Error("--large-mib must be an integer from 16 to 2048.");
      options.largeMiB = Number(value);
    } else throw new Error("Unknown fixture option; use --help.");
  }
  return options;
}

export function validateManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.formatVersion !== 1 ||
    value.generator !== "MediaVault FFmpeg fixtures" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.media) ||
    value.media.length < 2 ||
    value.media.length > 5 ||
    !Array.isArray(value.assets) ||
    value.assets.length < 4 ||
    value.assets.length > 4096
  )
    throw fail();
  const names = new Set();
  for (const item of value.assets) {
    if (
      !item ||
      typeof item !== "object" ||
      !fixtureAssetName.test(item.file) ||
      names.has(item.file) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      item.bytes > MAX_ASSET_BYTES ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw fail();
    names.add(item.file);
  }
  for (const file of ["clip-10s.mp4", "clip-60s.mp4", "hls/index.m3u8"])
    if (!names.has(file)) throw fail();
  const media = new Set();
  for (const item of value.media) {
    if (
      !item ||
      !names.has(item.file) ||
      media.has(item.file) ||
      !Number.isFinite(item.duration) ||
      item.duration <= 0 ||
      item.duration > 86400 ||
      item.videoCodec !== "h264" ||
      item.audioCodec !== "aac" ||
      !Number.isSafeInteger(item.width) ||
      !Number.isSafeInteger(item.height) ||
      item.width < 16 ||
      item.width > 4096 ||
      item.height < 16 ||
      item.height > 2160
    )
      throw fail();
    media.add(item.file);
  }
  if (!["clip-10s.mp4", "clip-60s.mp4"].every((file) => media.has(file))) throw fail();
  return value;
}

/** Resolve every parent and compare the opened descriptor; directory junctions never serve files. */
export async function openFixtureAsset(directory, file) {
  if (file !== "manifest.json" && !fixtureAssetName.test(file)) throw fail();
  const path = join(directory, ...file.split("/"));
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    !samePath(await realpath(path), path)
  )
    throw fail();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.ino !== before.ino ||
      info.dev !== before.dev ||
      info.size !== before.size
    )
      throw fail();
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inspectAsset(directory, file) {
  const { handle, info } = await openFixtureAsset(directory, file);
  try {
    if (info.size <= 0n || info.size > BigInt(MAX_ASSET_BYTES)) throw fail();
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_ASSET_BYTES) throw fail();
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes) !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs)
      throw fail();
    return { file, bytes, sha256: hash.digest("hex"), identity: info };
  } finally {
    await handle.close();
  }
}

export async function loadFixtureManifest(input) {
  const directory = await canonicalFixtureDirectory(input);
  const { handle, info } = await openFixtureAsset(directory, "manifest.json");
  let manifest;
  try {
    if (info.size <= 0n || info.size > 1024n * 1024n) throw fail();
    const bytes = Buffer.alloc(Number(info.size) + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (BigInt(result.bytesRead) !== info.size) throw fail();
    manifest = validateManifest(JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")));
  } finally {
    await handle.close();
  }
  const assets = new Map();
  for (const item of manifest.assets) {
    const actual = await inspectAsset(directory, item.file);
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw fail();
    assets.set(item.file, actual);
  }
  return { directory, manifest, assets };
}

async function toolPath(name, override) {
  const path =
    override ||
    process.env[`MEDIAVAULT_${name.toUpperCase()}_PATH`] ||
    join(repository, "resources", "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
  if (
    !isAbsolute(path) ||
    (process.platform === "win32" && extname(path).toLowerCase() !== ".exe") ||
    !(await lstat(path)).isFile()
  )
    throw new Error("Install FFmpeg and ffprobe first: npm run setup:ffmpeg");
  await access(path, constants.X_OK);
  return path;
}
async function run(binary, args, signal, timeout = 300_000, cwd) {
  // FFmpeg's manifest URL resolution uses forward slashes, including on Windows.
  const portableArgs = args.map((argument) =>
    isAbsolute(argument) ? argument.replaceAll("\\", "/") : argument,
  );
  try {
    return await execute(binary, portableArgs, {
      shell: false,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      timeout,
      signal,
      cwd,
    });
  } catch {
    throw new Error(
      signal?.aborted
        ? "Fixture generation cancelled; generated data was retained."
        : "FFmpeg fixture generation/probing failed; generated data was retained.",
    );
  }
}
async function probe(binary, directory, file, expectedDuration, signal) {
  const { stdout } = await run(
    binary,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,crypto,data",
      "-show_entries",
      "format=duration:stream=codec_name,codec_type,width,height",
      "-of",
      "json",
      join(directory, ...file.split("/")),
    ],
    signal,
    30_000,
    directory,
  );
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw fail();
  }
  const video = value.streams?.find((stream) => stream.codec_type === "video");
  const audio = value.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(value.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    (expectedDuration && Math.abs(duration - expectedDuration) > 0.5) ||
    video?.codec_name !== "h264" ||
    audio?.codec_name !== "aac"
  )
    throw new Error("Generated fixture did not pass ffprobe validation.");
  return {
    file,
    duration,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
  };
}

export async function generateFixtures({
  outputDirectory = join(repository, "artifacts", "fixtures"),
  dash = false,
  largeMiB = 0,
  signal,
  ffmpegPath,
  ffprobePath,
} = {}) {
  if (
    typeof dash !== "boolean" ||
    !Number.isSafeInteger(largeMiB) ||
    largeMiB < 0 ||
    (largeMiB !== 0 && largeMiB < 16) ||
    largeMiB > 2048
  )
    throw new Error("Invalid fixture generation options.");
  const ffmpeg = await toolPath("ffmpeg", ffmpegPath);
  const ffprobe = await toolPath("ffprobe", ffprobePath);
  const parent = await canonicalFixtureDirectory(outputDirectory, true);
  const disk = await statfs(parent, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt((largeMiB * 2 + 256) * 1024 * 1024))
    throw new Error("Insufficient space for generated fixtures.");
  const directory = await mkdtemp(join(parent, "run-"));
  await writeFile(
    join(directory, ".incomplete"),
    "MediaVault generated fixture work; no user media.\n",
    { flag: "wx", mode: 0o600 },
  );
  const media = [];
  for (const [seconds, width, height] of [
    [10, 1920, 1080],
    [60, 640, 360],
  ]) {
    const file = `clip-${seconds}s.mp4`;
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-n",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${width}x${height}:rate=24`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "48",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        "-shortest",
        join(directory, file),
      ],
      signal,
      300_000,
      directory,
    );
    media.push(await probe(ffprobe, directory, file, seconds, signal));
  }
  await mkdir(join(directory, "hls"));
  await run(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-n",
      "-i",
      join(directory, "clip-60s.mp4"),
      "-c",
      "copy",
      "-hls_time",
      "4",
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      join(directory, "hls", "segment-%03d.ts"),
      join(directory, "hls", "index.m3u8"),
    ],
    signal,
    300_000,
    directory,
  );
  media.push(await probe(ffprobe, directory, "hls/index.m3u8", 60, signal));
  if (dash) {
    await mkdir(join(directory, "dash"));
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-n",
        "-i",
        join(directory, "clip-60s.mp4"),
        "-map",
        "0",
        "-c",
        "copy",
        "-f",
        "dash",
        "-seg_duration",
        "4",
        "-use_template",
        "1",
        "-use_timeline",
        "1",
        "-init_seg_name",
        "init-$RepresentationID$.m4s",
        "-media_seg_name",
        "chunk-$RepresentationID$-$Number%05d$.m4s",
        join(directory, "dash", "index.mpd"),
      ],
      signal,
      300_000,
      directory,
    );
    media.push(await probe(ffprobe, directory, "dash/index.mpd", 60, signal));
  }
  if (largeMiB) {
    const original = await lstat(join(directory, "clip-60s.mp4"));
    const loops = Math.ceil((largeMiB * 1024 * 1024) / original.size) + 1;
    await run(
      ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-n",
        "-stream_loop",
        String(loops - 1),
        "-i",
        join(directory, "clip-60s.mp4"),
        "-map",
        "0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        join(directory, "large.mp4"),
      ],
      signal,
      300_000,
      directory,
    );
    media.push(await probe(ffprobe, directory, "large.mp4", undefined, signal));
    if ((await lstat(join(directory, "large.mp4"))).size < largeMiB * 1024 * 1024)
      throw new Error("Generated larger video did not meet the requested minimum size.");
  }
  const files = ["clip-10s.mp4", "clip-60s.mp4", ...(largeMiB ? ["large.mp4"] : [])];
  for (const folder of ["hls", ...(dash ? ["dash"] : [])])
    for (const file of await readdir(join(directory, folder))) files.push(`${folder}/${file}`);
  const assets = [];
  for (const file of files.sort()) {
    const { identity: _identity, ...asset } = await inspectAsset(directory, file);
    assets.push(asset);
  }
  const manifest = validateManifest({
    formatVersion: 1,
    generator: "MediaVault FFmpeg fixtures",
    createdAt: new Date().toISOString(),
    media,
    assets,
  });
  const output = await open(join(directory, ".manifest.tmp"), "wx", 0o600);
  try {
    await output.writeFile(JSON.stringify(manifest, null, 2) + "\n");
    await output.sync();
  } finally {
    await output.close();
  }
  await rename(join(directory, ".manifest.tmp"), join(directory, "manifest.json"));
  await unlink(join(directory, ".incomplete"));
  return { directory, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseGeneratorArguments(process.argv.slice(2));
    if (options.help)
      console.log(`Generate MediaVault media using only FFmpeg test patterns and a sine tone.
Usage: npm run fixtures:generate -- [--output DIRECTORY] [--dash] [--large-mib 16..2048]
Default parent: artifacts/fixtures. Every run creates a new run-* directory.
Always generates 10s 1080p MP4, 60s 360p MP4, and 60s HLS with audio.
--dash adds DASH. --large-mib repeats generated video into a real playable MP4
at least that size; it is not a sparse file. Requires extra disk space and time.
All outputs remain for inspection. Existing directories/files are never replaced.
Install FFmpeg/ffprobe first: npm run setup:ffmpeg`);
    else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const result = await generateFixtures({ ...options, signal: controller.signal });
        console.log(`Generated and ffprobe-validated fixtures: ${result.directory}`);
        console.log(`Manifest: ${join(result.directory, "manifest.json")}`);
        console.log(`Serve with: npm run fixtures:serve -- --directory "${result.directory}"`);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
  } catch (error) {
    console.error(
      error instanceof Error && !error.code
        ? error.message
        : "Fixture generation failed; check the output location and FFmpeg setup.",
    );
    process.exitCode = 1;
  }
}
