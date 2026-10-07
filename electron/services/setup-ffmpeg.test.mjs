import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installFFmpeg } from "../../scripts/setup-ffmpeg.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const files = [],
    directory = [];
  let offset = 0;
  for (const [name, content = "MZfixture", attributes = 0] of entries) {
    const filename = Buffer.from(name),
      data = Buffer.from(content),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(attributes, 38);
    central.writeUInt32LE(offset, 42);
    files.push(header, filename, data);
    directory.push(central, filename);
    offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}
const prefix = "ffmpeg-9.0.2-essentials_build";
const validEntries = [
  [`${prefix}/bin/ffmpeg.exe`],
  [`${prefix}/bin/ffprobe.exe`],
  [`${prefix}/bin/ffplay.exe`],
];
async function fixture(run, entries = validEntries, checksum) {
  const directory = await mkdtemp(join(tmpdir(), "mediavault-ffmpeg-setup-"));
  const archive = zip(entries),
    requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(
      url.endsWith("release-version")
        ? "9.0.2\n"
        : url.endsWith(".sha256")
          ? (checksum ?? createHash("sha256").update(archive).digest("hex"))
          : archive,
    );
  };
  try {
    await run({ directory, platform: "win32", arch: "x64", fetchImpl }, requests);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("installs only both checked executables from one pinned release", async () => {
  await fixture(async (options, requests) => {
    await installFFmpeg(options);
    assert.deepEqual((await readdir(options.directory)).sort(), ["ffmpeg.exe", "ffprobe.exe"]);
    assert.equal(await readFile(join(options.directory, "ffmpeg.exe"), "utf8"), "MZfixture");
    assert.ok(
      requests.some(
        (url) =>
          url === `https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/${prefix}.zip`,
      ),
    );
    assert.ok(requests.some((url) => url.endsWith(`/packages/${prefix}.zip.sha256`)));
  });
});
test("refuses bad checksums before extracting anything", async () => {
  await fixture(
    async (options) => {
      await assert.rejects(installFFmpeg(options), /checksum/);
      assert.deepEqual(await readdir(options.directory), []);
    },
    validEntries,
    "0".repeat(64),
  );
});
test("never overwrites either executable or fetches when one already exists", async () => {
  await fixture(async (options, requests) => {
    await writeFile(join(options.directory, "ffprobe.exe"), "existing");
    await assert.rejects(installFFmpeg(options), /already exists/);
    assert.equal(requests.length, 0);
    assert.equal(await readFile(join(options.directory, "ffprobe.exe"), "utf8"), "existing");
  });
});
test("rejects traversal, symbolic links, duplicates, missing tools and non-executables", async () => {
  const invalid = [
    [...validEntries, [`${prefix}/../../outside.exe`]],
    [[`${prefix}/bin/ffmpeg.exe`, "MZfixture", 0xa1ff0000], validEntries[1]],
    [...validEntries, validEntries[0]],
    [validEntries[0]],
    [[`${prefix}/bin/ffmpeg.exe`, "not executable"], validEntries[1]],
  ];
  for (const entries of invalid)
    await fixture(async (options) => {
      await assert.rejects(installFFmpeg(options));
      assert.deepEqual(await readdir(options.directory), []);
    }, entries);
});
test("rejects unsupported platforms and unsafe version strings before fetching", async () => {
  await fixture(async (options, requests) => {
    await assert.rejects(installFFmpeg({ ...options, platform: "linux" }), /Unsupported/);
    await assert.rejects(installFFmpeg({ ...options, version: "../../latest" }), /version/);
    assert.equal(requests.length, 0);
  });
});

test("cleans staging when a download exceeds its limit or the response fails", async () => {
  for (const oversized of [true, false]) {
    await fixture(async (options) => {
      const fetchImpl = async (url) => {
        if (!url.endsWith(".zip")) return options.fetchImpl(url);
        return oversized
          ? new Response("partial", { headers: { "content-length": String(201 * 1024 * 1024) } })
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1]));
                  controller.error(new Error("connection closed"));
                },
              }),
            );
      };
      await assert.rejects(installFFmpeg({ ...options, fetchImpl }));
      assert.deepEqual(await readdir(options.directory), []);
    });
  }
});
