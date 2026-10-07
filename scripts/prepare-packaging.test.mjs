import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { preparePackaging } from "./prepare-packaging.mjs";

async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === "object" ? JSON.stringify(value) : value);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mediavault-packaging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "package.json", {
    name: "mediavault",
    productName: "MediaVault",
    version: "0.1.0",
    description: "MediaVault",
    author: "test",
    main: "dist-electron/main.cjs",
    dependencies: { "better-sqlite3": "^13.0.3", "electron-updater": "6.8.9", react: "^19.0.0" },
  });
  for (const name of ["main.cjs", "preload.cjs"])
    await put(root, `dist-electron/${name}`, "module.exports = {};");
  await put(root, "dist-electron/main.cjs.map", "source map");
  await put(root, "dist-electron/private.ts", "development source");
  await put(root, "dist-desktop/index.html", "<!doctype html><title>MediaVault</title>");
  await put(root, "dist-desktop/assets/app.js", "console.log('app');");
  await put(root, "dist-desktop/assets/app.js.map", "private source");
  await put(root, "dist-desktop/.env", "SECRET=value");
  await put(root, "node_modules/better-sqlite3/package.json", {
    name: "better-sqlite3",
    version: "13.0.3",
    main: "lib/index.js",
    dependencies: { "node-addon-api": "^8.0.0" },
  });
  await put(
    root,
    "node_modules/better-sqlite3/lib/index.js",
    "module.exports = require('../prebuilds/win32-x64.node');",
  );
  await put(root, "node_modules/better-sqlite3/prebuilds/win32-x64.node", "native-x64");
  await put(root, "node_modules/better-sqlite3/prebuilds/linux-x64.node", "not for Windows");
  await put(root, "node_modules/better-sqlite3/src/private.cpp", "not needed at runtime");
  await put(root, "node_modules/better-sqlite3/LICENSE", "MIT fixture");
  await put(root, "node_modules/node-addon-api/package.json", {
    name: "node-addon-api",
    version: "8.9.2",
    main: "index.js",
  });
  await put(root, "node_modules/node-addon-api/index.js", "module.exports = {};");
  await put(root, "node_modules/node-addon-api/LICENSE.md", "MIT fixture");
  await put(root, "node_modules/electron-updater/package.json", {
    name: "electron-updater",
    version: "6.8.9",
    main: "out/main.js",
    dependencies: { "updater-fixture-runtime": "1.0.0" },
  });
  await put(
    root,
    "node_modules/electron-updater/out/main.js",
    "module.exports = require('updater-fixture-runtime');",
  );
  await put(root, "node_modules/electron-updater/LICENSE", "MIT fixture");
  await put(
    root,
    "node_modules/electron-updater/node_modules/updater-fixture-runtime/package.json",
    {
      name: "updater-fixture-runtime",
      version: "1.0.0",
      main: "index.js",
    },
  );
  await put(
    root,
    "node_modules/electron-updater/node_modules/updater-fixture-runtime/index.js",
    "module.exports = {};",
  );
  await put(
    root,
    "node_modules/electron-updater/node_modules/updater-fixture-runtime/LICENSE",
    "MIT fixture",
  );
  await put(root, "node_modules/react/package.json", { name: "react", version: "19.0.0" });
  await put(root, "node_modules/react/LICENSE", "React license fixture");
  await put(root, "node_modules/react/lib-vendor/example/LICENSE", "Vendored license fixture");
  await put(root, "THIRD-PARTY-NOTICES.md", "Third-party notices fixture");
  const binaries = [];
  for (const file of ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"]) {
    const bytes = `verified ${file}`;
    await put(root, `resources/bin/${file}`, bytes);
    binaries.push({
      file,
      version: file === "yt-dlp.exe" ? "2026.08.19" : "9.0.2",
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      licenseFiles: ["GPL-3.0.txt"],
    });
  }
  await put(root, "resources/notices/binaries.json", {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    binaries,
  });
  await put(root, "resources/notices/GPL-3.0.txt", "GPL fixture");
  for (const name of ["icon.ico", "icon-256.png", "tray.png", "installer.ico"])
    await put(root, `resources/branding/${name}`, "icon fixture");
  return root;
}

test("stages the runtime dependency closure and verified resources without development or secret files", async (t) => {
  const root = await fixture(t);
  const result = await preparePackaging({ root });
  assert.equal(result.appDirectory, join(root, "artifacts/package-app"));
  assert.equal(result.resourcesDirectory, join(root, "artifacts/package-resources"));
  const app = JSON.parse(await readFile(join(result.appDirectory, "package.json"), "utf8"));
  assert.deepEqual(app.dependencies, { "better-sqlite3": "13.0.3", "electron-updater": "6.8.9" });
  assert.equal(app.main, "dist-electron/main.cjs");
  assert.deepEqual(await readdir(join(result.appDirectory, "node_modules")), [
    "better-sqlite3",
    "electron-updater",
    "node-addon-api",
  ]);
  assert.equal(
    await readFile(
      join(
        result.appDirectory,
        "node_modules/electron-updater/node_modules/updater-fixture-runtime/index.js",
      ),
      "utf8",
    ),
    "module.exports = {};",
  );
  assert.deepEqual(
    await readdir(join(result.appDirectory, "node_modules/better-sqlite3/prebuilds")),
    ["win32-x64.node"],
  );
  assert.deepEqual(await readdir(join(result.appDirectory, "dist-electron")), [
    "main.cjs",
    "preload.cjs",
  ]);
  assert.deepEqual(await readdir(join(result.appDirectory, "dist-desktop")), [
    "assets",
    "index.html",
  ]);
  assert.deepEqual(await readdir(join(result.appDirectory, "dist-desktop/assets")), ["app.js"]);
  assert.equal(
    await readFile(join(result.resourcesDirectory, "bin/ffmpeg.exe"), "utf8"),
    "verified ffmpeg.exe",
  );
  assert.equal(
    await readFile(join(result.resourcesDirectory, "notices/THIRD-PARTY-NOTICES.md"), "utf8"),
    "Third-party notices fixture",
  );
  assert.equal(
    await readFile(
      join(result.resourcesDirectory, "notices/npm/node_modules/react/LICENSE"),
      "utf8",
    ),
    "React license fixture",
  );
  const licenses = JSON.parse(
    await readFile(join(result.resourcesDirectory, "notices/npm/index.json"), "utf8"),
  );
  assert.ok(licenses.some((item) => item.name === "react" && item.version === "19.0.0"));
  assert.equal(
    await readFile(
      join(result.resourcesDirectory, "notices/npm/node_modules/react/lib-vendor/example/LICENSE"),
      "utf8",
    ),
    "Vendored license fixture",
  );
});

test("rejects changed binaries before replacing an existing staged application", async (t) => {
  const root = await fixture(t);
  await preparePackaging({ root });
  await put(root, "artifacts/package-app/retained.txt", "old staged build");
  await put(root, "resources/bin/ffmpeg.exe", "tampered");
  await assert.rejects(preparePackaging({ root }), /checksum|manifest/i);
  assert.equal(
    await readFile(join(root, "artifacts/package-app/retained.txt"), "utf8"),
    "old staged build",
  );
  assert.deepEqual((await readdir(join(root, "artifacts"))).sort(), [
    "package-app",
    "package-resources",
  ]);
});

test("rejects manifest traversal and missing upstream license files", async (t) => {
  const root = await fixture(t);
  const path = join(root, "resources/notices/binaries.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.binaries[0].file = "../secret.exe";
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(preparePackaging({ root }), /manifest/i);
  manifest.binaries[0].file = "yt-dlp.exe";
  manifest.binaries[0].licenseFiles = ["missing-license.txt"];
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(preparePackaging({ root }), /license|ENOENT/i);
});

test("does not follow an artifacts junction outside the project", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "mediavault-package-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "keep.txt"), "keep");
  await symlink(
    outside,
    join(root, "artifacts"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(preparePackaging({ root }), /link|directory|confined/i);
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
});

test("rejects a symlinked resource directory rather than copying unrelated files", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "resources/bin"), { recursive: true });
  await symlink(
    join(root, "dist-electron"),
    join(root, "resources/bin"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(preparePackaging({ root }), /link|directory|confined/i);
});

test("repeat staging removes stale output and never modifies source native binaries", async (t) => {
  const root = await fixture(t);
  const result = await preparePackaging({ root });
  await put(root, "artifacts/package-app/stale.txt", "old output");
  await preparePackaging({ root });
  await assert.rejects(readFile(join(result.appDirectory, "stale.txt")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(root, "node_modules/better-sqlite3/prebuilds/win32-x64.node"), "utf8"),
    "native-x64",
  );
});

test("rejects replacement of a staged output junction without deleting the external target", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "mediavault-package-replacement-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "keep.txt"), "keep");
  await mkdir(join(root, "artifacts"));
  await symlink(
    outside,
    join(root, "artifacts/package-app"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(preparePackaging({ root }), /link|directory|confined/i);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
});
