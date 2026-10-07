import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/yt-dlp/yt-dlp";
const validVersion = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;

export function releaseAsset(platform, arch) {
  if (platform === "win32") {
    if (arch === "x64") return "yt-dlp.exe";
    if (arch === "arm64") return "yt-dlp_arm64.exe";
    if (arch === "ia32") return "yt-dlp_x86.exe";
  }
  if (platform === "darwin" && ["x64", "arm64"].includes(arch)) return "yt-dlp_macos";
  if (platform === "linux") {
    if (arch === "x64") return "yt-dlp_linux";
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
  }
  throw new Error(
    "Unsupported platform or architecture. Set MEDIAVAULT_YTDLP_PATH to a trusted executable for development.",
  );
}

async function fetchBytes(url, limit, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "MediaVault-binary-setup",
      Accept: url.startsWith("https://api.github.com/")
        ? "application/vnd.github+json"
        : "application/octet-stream",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Official yt-dlp release download failed (HTTP ${response.status}).`);
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error("Official yt-dlp release file exceeded its size limit.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Official yt-dlp release file exceeded its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Downloads never run on import or during npm install. The CLI is explicit. */
export async function installYtDlp({
  directory = fileURLToPath(new URL("../resources/bin", import.meta.url)),
  platform = process.platform,
  arch = process.arch,
  version = process.env.MEDIAVAULT_YTDLP_VERSION || "latest",
  fetchImpl = fetch,
} = {}) {
  if (version !== "latest" && !validVersion.test(version))
    throw new Error("Invalid yt-dlp release version.");
  const asset = releaseAsset(platform, arch);
  const destination = join(resolve(directory), platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  try {
    await lstat(destination);
    throw new Error("yt-dlp already exists. Remove it explicitly before running setup again.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (version === "latest") {
    const metadata = JSON.parse(
      (
        await fetchBytes(
          "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
          1024 * 1024,
          fetchImpl,
        )
      ).toString("utf8"),
    );
    if (typeof metadata?.tag_name !== "string" || !validVersion.test(metadata.tag_name)) {
      throw new Error("Invalid official yt-dlp release metadata.");
    }
    version = metadata.tag_name;
  }
  const base = `${repository}/releases/download/${version}`;
  const manifest = (await fetchBytes(`${base}/SHA2-256SUMS`, 1024 * 1024, fetchImpl)).toString(
    "utf8",
  );
  const checksums = manifest.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/.exec(line);
    return match && match[2] === asset ? [match[1].toLowerCase()] : [];
  });
  if (checksums.length !== 1)
    throw new Error("The official release has no unique checksum for this executable.");
  const binary = await fetchBytes(`${base}/${asset}`, 128 * 1024 * 1024, fetchImpl);
  if (binary.length === 0 || createHash("sha256").update(binary).digest("hex") !== checksums[0]) {
    throw new Error("yt-dlp checksum verification failed; nothing was installed.");
  }

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    const file = await open(temporary, "wx", 0o700);
    try {
      await file.writeFile(binary);
      await file.sync();
    } finally {
      await file.close();
    }
    if (platform !== "win32") await chmod(temporary, 0o755);
    // Creating a hard link is atomic and refuses to overwrite a competing installer.
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installYtDlp()
    .then(() => {
      console.log("Verified official yt-dlp executable installed in resources/bin.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "yt-dlp setup failed.");
      process.exitCode = 1;
    });
}
