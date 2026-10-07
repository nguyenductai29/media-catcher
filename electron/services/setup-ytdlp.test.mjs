import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installYtDlp, releaseAsset } from "../../scripts/setup-ytdlp.mjs";

test("selects official standalone assets and rejects unsupported architectures", () => {
  assert.equal(releaseAsset("win32", "x64"), "yt-dlp.exe");
  assert.equal(releaseAsset("win32", "arm64"), "yt-dlp_arm64.exe");
  assert.equal(releaseAsset("darwin", "arm64"), "yt-dlp_macos");
  assert.equal(releaseAsset("linux", "x64"), "yt-dlp_linux");
  assert.equal(releaseAsset("linux", "arm64"), "yt-dlp_linux_aarch64");
  assert.throws(() => releaseAsset("linux", "mips"), /Unsupported/);
});

test("installs only a checksum-verified binary from a pinned official release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediavault-setup-"));
  const bytes = Buffer.from("a deterministic executable fixture");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const requested = [];
  try {
    const destination = await installYtDlp({
      directory,
      platform: "win32",
      arch: "x64",
      version: "2026.01.01",
      fetchImpl: async (url) => {
        requested.push(url);
        if (url.endsWith("SHA2-256SUMS")) return new Response(`${checksum}  yt-dlp.exe\n`);
        return new Response(bytes);
      },
    });
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(requested, [
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.01.01/SHA2-256SUMS",
      "https://github.com/yt-dlp/yt-dlp/releases/download/2026.01.01/yt-dlp.exe",
    ]);
    assert.deepEqual(await readdir(directory), ["yt-dlp.exe"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checksum mismatch creates no executable or partial file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediavault-setup-"));
  try {
    await assert.rejects(
      installYtDlp({
        directory,
        platform: "win32",
        arch: "x64",
        version: "2026.01.01",
        fetchImpl: async (url) =>
          url.endsWith("SHA2-256SUMS")
            ? new Response(`${"a".repeat(64)}  yt-dlp.exe\n`)
            : new Response("tampered binary"),
      }),
      /checksum/i,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requests latest-release metadata as JSON before fetching release files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediavault-setup-"));
  const bytes = Buffer.from("latest release fixture");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  try {
    const destination = await installYtDlp({
      directory,
      platform: "win32",
      arch: "x64",
      version: "latest",
      fetchImpl: async (url, options) => {
        if (url.startsWith("https://api.github.com/")) {
          if (options.headers.Accept !== "application/vnd.github+json")
            return new Response("unsupported accept header", { status: 415 });
          return Response.json({ tag_name: "2026.01.01" });
        }
        assert.ok(url.startsWith("https://github.com/yt-dlp/yt-dlp/releases/download/2026.01.01/"));
        return url.endsWith("SHA2-256SUMS")
          ? new Response(`${checksum}  yt-dlp.exe\n`)
          : new Response(bytes);
      },
    });
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never replaces an existing executable or fetches an invalid release tag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mediavault-setup-"));
  const destination = join(directory, "yt-dlp.exe");
  let requested = false;
  const fetchImpl = async () => {
    requested = true;
    throw new Error("unexpected network request");
  };
  try {
    await writeFile(destination, "keep existing");
    await assert.rejects(
      installYtDlp({ directory, platform: "win32", arch: "x64", version: "2026.01.01", fetchImpl }),
      /already exists/i,
    );
    assert.equal(await readFile(destination, "utf8"), "keep existing");
    assert.equal(requested, false);
    await assert.rejects(
      installYtDlp({
        directory,
        platform: "win32",
        arch: "x64",
        version: "../../other",
        fetchImpl,
      }),
      /release/i,
    );
    assert.equal(requested, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
