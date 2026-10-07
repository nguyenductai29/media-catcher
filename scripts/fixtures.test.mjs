import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  generateFixtures,
  parseGeneratorArguments,
  validateManifest,
  loadFixtureManifest,
  openFixtureAsset,
} from "./generate-fixtures.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mediavault-fixture-test-"));
  const bytes = Buffer.alloc(256 * 1024, 27);
  bytes.write("ftyp", 4);
  const manifest = {
    formatVersion: 1,
    generator: "MediaVault FFmpeg fixtures",
    createdAt: new Date().toISOString(),
    media: [
      {
        file: "clip-10s.mp4",
        duration: 10,
        width: 1920,
        height: 1080,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      {
        file: "clip-60s.mp4",
        duration: 60,
        width: 640,
        height: 360,
        videoCodec: "h264",
        audioCodec: "aac",
      },
    ],
    assets: [],
  };
  for (const file of ["clip-10s.mp4", "clip-60s.mp4"]) {
    await writeFile(join(directory, file), bytes);
    manifest.assets.push({
      file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await mkdir(join(directory, "hls"));
  for (const [file, contents] of [
    [
      "hls/index.m3u8",
      "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment-000.ts\n#EXT-X-ENDLIST\n",
    ],
    ["hls/segment-000.ts", Buffer.alloc(188, 71)],
  ]) {
    await writeFile(join(directory, file), contents);
    manifest.assets.push({
      file,
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, bytes, manifest };
}

test("generator arguments reject unsafe, unsupported or unbounded values", () => {
  assert.equal(parseGeneratorArguments(["--dash", "--large-mib", "128"]).largeMiB, 128);
  assert.equal(parseGeneratorArguments([]).dash, false);
  for (const args of [
    ["--large-mib", "0"],
    ["--large-mib", "999999"],
    ["--large-mib", "1.5"],
    ["--output"],
    ["--force"],
    ["--output", "a", "--output", "b"],
  ])
    assert.throws(() => parseGeneratorArguments(args));
});
test("manifest rejects paths and fabricated media metadata", async () => {
  const f = await fixture();
  try {
    assert.equal(validateManifest(f.manifest).assets.length, 4);
    for (const file of [
      "../private.mp4",
      "C:/secret.mp4",
      "hls/../../private.mp4",
      "hls\\segment-000.ts",
      "auth.dat",
    ])
      assert.throws(() =>
        validateManifest({ ...f.manifest, assets: [{ ...f.manifest.assets[0], file }] }),
      );
    assert.throws(() =>
      validateManifest({ ...f.manifest, media: [{ ...f.manifest.media[0], duration: 0 }] }),
    );
    await writeFile(join(f.directory, "clip-10s.mp4"), "tampered");
    await assert.rejects(loadFixtureManifest(f.directory));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("fixture serving supports full, HEAD, suffix and bounded ranges", async () => {
  const f = await fixture();
  const server = await startFixtureServer({ directory: f.directory });
  try {
    const full = await fetch(`${server.origin}/clip-10s.mp4`);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.bytes);
    const ranged = await fetch(`${server.origin}/clip-10s.mp4`, {
      headers: { Range: "bytes=10-19" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 10-19/${f.bytes.length}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    const suffix = await fetch(`${server.origin}/clip-10s.mp4`, { headers: { Range: "bytes=-7" } });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 7);
    const head = await fetch(`${server.origin}/clip-10s.mp4`, { method: "HEAD" });
    assert.equal(Number(head.headers.get("content-length")), f.bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const range of ["bytes=999999999-", "bytes=20-10", "bytes=0-1,3-4", "invalid"]) {
      const response = await fetch(`${server.origin}/clip-10s.mp4`, { headers: { Range: range } });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get("content-range"), `bytes */${f.bytes.length}`);
    }
  } finally {
    await server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("login is HttpOnly and protected HTML/media require this server's test cookie", async () => {
  const f = await fixture();
  const server = await startFixtureServer({ directory: f.directory });
  try {
    assert.equal((await fetch(`${server.origin}/protected-video`)).status, 401);
    const login = await fetch(`${server.origin}/login`);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(
      (
        await fetch(`${server.origin}/protected-video`, {
          headers: { Cookie: cookie.split(";")[0] },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${server.origin}/protected.mp4`, {
          method: "HEAD",
          headers: { Cookie: cookie.split(";")[0] },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${server.origin}/protected.mp4`, {
          headers: { Cookie: "mv_fixture_session=wrong" },
        })
      ).status,
      401,
    );
    assert.equal(
      JSON.stringify(server.status()).includes(cookie.split("=")[1].split(";")[0]),
      false,
    );
    assert.match(await (await fetch(`${server.origin}/hls/index.m3u8`)).text(), /#EXTM3U/);
  } finally {
    await server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("serving refuses unknown paths, host spoofing and redirected media files", async () => {
  const f = await fixture();
  const server = await startFixtureServer({ directory: f.directory });
  try {
    for (const path of [
      "/manifest.json",
      "/auth.dat",
      "/hls/%2e%2e%2fmanifest.json",
      "/clip-10s.mp4%00",
    ])
      assert.ok((await fetch(`${server.origin}${path}`)).status >= 400);
    const spoofedStatus = await new Promise((resolve, reject) => {
      const connection = request(
        `${server.origin}/`,
        { headers: { Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      connection.once("error", reject);
      connection.end();
    });
    assert.equal(spoofedStatus, 400);
    const elsewhere = join(f.directory, "other");
    await mkdir(elsewhere);
    await rm(join(f.directory, "hls"), { recursive: true });
    await writeFile(join(elsewhere, "index.m3u8"), "private data");
    await symlink(
      elsewhere,
      join(f.directory, "hls"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const response = await fetch(`${server.origin}/hls/index.m3u8`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /private data/);
  } finally {
    await server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("interruption, offline recovery, throttling and shutdown release active streams", async () => {
  const f = await fixture();
  const server = await startFixtureServer({ directory: f.directory, interruptAfterKiB: 32 });
  try {
    await assert.rejects(async () => (await fetch(`${server.origin}/clip-60s.mp4`)).arrayBuffer());
    server.configure({ offline: true });
    assert.equal((await fetch(`${server.origin}/clip-60s.mp4`)).status, 503);
    server.configure({ offline: false, interruptAfterKiB: 0, throttleKiB: 1 });
    const response = await fetch(`${server.origin}/clip-60s.mp4`);
    const outcome = response.arrayBuffer().catch(() => null);
    assert.ok(server.status().activeStreams > 0);
    await server.close();
    assert.equal(await outcome, null);
    assert.equal(server.status().activeStreams, 0);
    assert.throws(() => server.configure({ throttleKiB: -1 }));
  } finally {
    await server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("disconnect and offline during file open release the handle without starting a stream", async () => {
  const f = await fixture();
  let opened;
  let release;
  let signalOpened;
  let ready = new Promise((resolve) => {
    signalOpened = resolve;
  });
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await startFixtureServer(
    { directory: f.directory },
    {
      async openAsset(...args) {
        opened = await openFixtureAsset(...args);
        signalOpened();
        await gate;
        return opened;
      },
    },
  );
  let connection;
  try {
    connection = request(`${server.origin}/clip-10s.mp4`);
    connection.on("error", () => {});
    connection.end();
    await ready;
    connection.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    for (let i = 0; i < 20 && opened.handle.fd !== -1; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(opened.handle.fd, -1, "disconnected response must close its file immediately");
    assert.equal(server.status().activeStreams, 0);

    ready = new Promise((resolve) => {
      signalOpened = resolve;
    });
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const response = fetch(`${server.origin}/clip-10s.mp4`);
    await ready;
    server.configure({ offline: true });
    release();
    const offline = await response;
    assert.equal(offline.status, 503);
    await offline.arrayBuffer();
    for (let i = 0; i < 20 && opened.handle.fd !== -1; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(opened.handle.fd, -1);
    assert.equal(server.status().mediaRequests, 0);
    assert.equal(server.status().activeStreams, 0);
  } finally {
    release();
    connection?.destroy();
    await server.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test(
  "real FFmpeg generates, probes and serves 10s/60s MP4, HLS, DASH and a playable larger fixture",
  {
    skip: !["ffmpeg", "ffprobe"].every((tool) =>
      existsSync(
        resolve("resources", "bin", `${tool}${process.platform === "win32" ? ".exe" : ""}`),
      ),
    ),
    timeout: 120_000,
  },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "mediavault-real-fixtures-"));
    let server;
    try {
      const result = await generateFixtures({ outputDirectory: parent, dash: true, largeMiB: 16 });
      assert.equal(
        result.manifest.media.find((media) => media.file === "clip-10s.mp4").height,
        1080,
      );
      assert.equal(
        result.manifest.media.find((media) => media.file === "clip-60s.mp4").duration,
        60,
      );
      assert.equal(
        result.manifest.media.find((media) => media.file === "hls/index.m3u8").duration,
        60,
      );
      assert.ok(
        result.manifest.media.find((media) => media.file === "dash/index.mpd").duration >= 59.5,
      );
      assert.ok(
        result.manifest.assets.find((asset) => asset.file === "large.mp4").bytes >=
          16 * 1024 * 1024,
      );
      assert.ok(result.manifest.media.find((media) => media.file === "large.mp4").duration > 60);
      assert.ok(result.manifest.assets.some((asset) => asset.file === "dash/init-0.m4s"));
      server = await startFixtureServer({ directory: result.directory });
      for (const path of ["/", "/video-10s", "/hls-video", "/dash-video", "/video-large"])
        assert.equal((await fetch(server.origin + path)).status, 200);
      const response = await fetch(`${server.origin}/large.mp4`, {
        headers: { Range: "bytes=0-31" },
      });
      assert.equal(response.status, 206);
      assert.equal((await response.arrayBuffer()).byteLength, 32);
      const dash = await (await fetch(`${server.origin}/dash/index.mpd`)).text();
      assert.match(dash, /SegmentTemplate/);
    } finally {
      await server?.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
