// Run after npm run build:desktop. Requires a graphical desktop session.
// All web traffic and browser profiles used by these checks are local fixtures.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedIndex = process.argv.indexOf("--packaged-executable");
const packagedExecutable = packagedIndex === -1 ? undefined : process.argv[packagedIndex + 1];
if (packagedIndex !== -1 && (!packagedExecutable || !isAbsolute(packagedExecutable)))
  throw new Error("--packaged-executable requires an absolute executable path.");
if (packagedExecutable && process.argv.includes("--dev"))
  throw new Error("Packaged smoke cannot use a development renderer.");
const packagedResources = packagedExecutable
  ? join(dirname(packagedExecutable), "resources")
  : undefined;
const expectedVersion =
  process.env.MEDIAVAULT_EXPECTED_VERSION ||
  JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const samePath = (a, b) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
const dictionaries = Object.fromEntries(
  await Promise.all(
    ["en", "vi"].map(async (lang) => [
      lang,
      JSON.parse(await readFile(join(root, "src", "locales", `${lang}.json`), "utf8")),
    ]),
  ),
);
const label = (key, lang = "en") => {
  const value = key.split(".").reduce((current, part) => current?.[part], dictionaries[lang]);
  assert.equal(typeof value, "string", `Missing ${lang} label: ${key}`);
  return value;
};
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function until(description, read, accept = Boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`, lastError ? { cause: lastError } : undefined);
}

for (const artifact of packagedExecutable
  ? [
      packagedExecutable,
      join(packagedResources, "app.asar"),
      ...["yt-dlp", "ffmpeg", "ffprobe"].map((name) =>
        join(packagedResources, "bin", `${name}.exe`),
      ),
    ]
  : [
      join(root, "dist-electron/main.cjs"),
      join(root, "dist-electron/preload.cjs"),
      join(root, "dist-desktop/index.html"),
    ]) {
  await access(artifact).catch(() => {
    throw new Error(`Missing ${artifact}; build the desktop app before running this smoke test.`);
  });
}

const scratch = await mkdtemp(
  join(tmpdir(), packagedExecutable ? "mediavault-smoke-Tiếng Việt 日本語-" : "mediavault-smoke-"),
);
const requests = new Map();
const fixturePath = join(scratch, "fixture.mp4");
const runExecutable = promisify(execFile);
const executable = (name) =>
  join(
    packagedResources ?? join(root, "resources"),
    "bin",
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
let mediaSize = 0;
const rangeRequests = [];
const authCookieName = "mv_smoke_http_only";
const authCookieValue = `mv-auth-${randomUUID()}`;
const authRequests = [];
let slowAuthMedia = false;
const cookieDirectory = (profile = "persistent-profile") =>
  join(scratch, profile, "browser-cookie-temp");
async function generateFixture() {
  await runExecutable(
    executable("ffmpeg"),
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
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-movflags",
      "+faststart",
      "-shortest",
      fixturePath,
    ],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
  );
  mediaSize = (await stat(fixturePath)).size;
  assert.ok(mediaSize > 32 * 1024, "generated media is unexpectedly small");
  await mkdir(join(scratch, "hls"));
  await runExecutable(
    executable("ffmpeg"),
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-n",
      "-i",
      fixturePath,
      "-c",
      "copy",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      join(scratch, "hls", "segment-%02d.ts"),
      join(scratch, "hls", "index.m3u8"),
    ],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
  );
}
const manifest =
  "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\n/segment-01.ts\n#EXT-X-ENDLIST\n";
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
  const send = (type, body, extra = {}) => {
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  if (url.pathname === "/login") {
    return send(
      "text/html; charset=utf-8",
      "<!doctype html><title>MediaVault signed-in fixture</title><h1>Signed in</h1>",
      {
        "Set-Cookie": `${authCookieName}=${authCookieValue}; HttpOnly; Path=/; SameSite=Lax`,
      },
    );
  }
  if (["/protected-video", "/protected.mp4"].includes(url.pathname)) {
    const authorized = (request.headers.cookie ?? "")
      .split(";")
      .some((cookie) => cookie.trim() === `${authCookieName}=${authCookieValue}`);
    // Record only a boolean, never cookie/header values.
    authRequests.push({ path: url.pathname, authorized });
    if (!authorized) {
      response.writeHead(401, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        request.method === "HEAD" ? undefined : "<!doctype html><title>Sign in required</title>",
      );
      return;
    }
    if (url.pathname === "/protected-video")
      return send(
        "text/html; charset=utf-8",
        '<!doctype html><title>MediaVault protected fixture</title><h1>Protected local video</h1><video controls preload="none"><source src="/protected.mp4" type="video/mp4"></video>',
      );
  }
  if (/^\/hls\/(?:index\.m3u8|segment-\d{2}\.ts)$/.test(url.pathname)) {
    const path = join(scratch, ...url.pathname.slice(1).split("/"));
    void stat(path)
      .then((info) => {
        response.writeHead(200, {
          "Content-Type": url.pathname.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
          "Content-Length": info.size,
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const source = createReadStream(path);
        source.on("error", () => response.destroy());
        response.on("close", () => source.destroy());
        source.pipe(response);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
    return;
  }
  if (["/clip.mp4", "/slow.mp4", "/protected.mp4"].includes(url.pathname)) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), mediaSize - 1) : mediaSize - 1;
    if (start >= mediaSize || start > end) {
      response.writeHead(416);
      response.end();
      return;
    }
    if (match) rangeRequests.push({ path: url.pathname, start });
    response.writeHead(match ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": end - start + 1,
      ...(match ? { "Content-Range": `bytes ${start}-${end}/${mediaSize}` } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const source = createReadStream(fixturePath, { start, end, highWaterMark: 4096 });
    response.on("close", () => source.destroy());
    source.on("error", () => response.destroy());
    if (url.pathname === "/clip.mp4" || (url.pathname === "/protected.mp4" && !slowAuthMedia))
      source.pipe(response);
    else
      void (async () => {
        try {
          for await (const chunk of source) {
            if (response.destroyed) break;
            response.write(chunk);
            await delay(150);
          }
          response.end();
        } catch {
          response.destroy();
        }
      })();
    return;
  }
  if (url.pathname === "/master.m3u8") return send("application/vnd.apple.mpegurl", manifest);
  if (url.pathname === "/segment-01.ts") return send("video/mp2t", Buffer.alloc(188));
  if (url.pathname === "/tiny.m4s") return send("video/mp4", Buffer.alloc(32));
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  const pageName =
    url.pathname === "/analysis"
      ? "MediaVault analysis fixture"
      : `MediaVault ${url.pathname.slice(1) || "home"}`;
  const video = ["/analysis", "/slow-analysis", "/hls-analysis"].includes(url.pathname)
    ? `<video controls preload="none"><source src="${url.pathname === "/hls-analysis" ? "/hls/index.m3u8" : url.pathname === "/analysis" ? "/clip.mp4" : "/slow.mp4"}" type="${url.pathname === "/hls-analysis" ? "application/vnd.apple.mpegurl" : "video/mp4"}"></video>`
    : "";
  const detection =
    url.pathname === "/media"
      ? `<script>
    window.fixtureReady = Promise.all([
      '/clip.mp4?signature=first', '/clip.mp4?signature=second',
      '/master.m3u8', '/segment-01.ts', '/tiny.m4s'
    ].map(url => fetch(url).then(response => response.arrayBuffer()))).then(() => true);
  </script>`
      : "";
  send(
    "text/html; charset=utf-8",
    `<!doctype html><html><head><title>${pageName}</title></head>
    <body><h1>${pageName}</h1><a id="next" href="/second">Next page</a>${video}${detection}</body></html>`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let app;
let page;
let devServer;
const rendererErrors = [];
let analysisResult = "binary unavailable; classified error verified";
let applicationPath = root;
let savedPackagedRuntime = false;

async function launch(profile, binaryPath, { fresh = false } = {}) {
  const profilePath = join(scratch, profile);
  await mkdir(profilePath, { recursive: true });
  if (!fresh)
    await writeFile(
      join(profilePath, "browser-settings.json"),
      JSON.stringify({
        version: 1,
        homepage: `${origin}/home`,
        saveSession: true,
      }),
      { flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const env = {
    ...process.env,
    MEDIAVAULT_USER_DATA: profilePath,
    MEDIAVAULT_VIDEOS_DIR: join(scratch, "videos"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MEDIAVAULT_DEV_URL;
  for (const name of ["MEDIAVAULT_YTDLP_PATH", "MEDIAVAULT_FFMPEG_PATH", "MEDIAVAULT_FFPROBE_PATH"])
    delete env[name];
  // Normal smoke must never authorize Google, even in a developer's configured shell.
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  if (devServer) env.MEDIAVAULT_DEV_URL = "http://127.0.0.1:5174";
  if (binaryPath !== undefined) env.MEDIAVAULT_YTDLP_PATH = binaryPath;
  const args = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"];
  if (packagedExecutable) {
    delete env.MEDIAVAULT_USER_DATA;
    delete env.MEDIAVAULT_VIDEOS_DIR;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const windowsDirectory = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.PATH = `${join(windowsDirectory, "System32")};${windowsDirectory}`;
    args.push(`--user-data-dir=${profilePath}`, `--media-videos-dir=${join(scratch, "videos")}`);
  } else args.unshift(".");
  app = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args,
    cwd: packagedExecutable ? dirname(packagedExecutable) : root,
    env,
    timeout: 30_000,
  });
  // Playwright also reports WebContentsView pages; their creation order is not stable.
  const rendererOrigin = devServer ? "http://127.0.0.1:5174/" : "mediavault://app/";
  page = await until(
    "application renderer window",
    () => app.windows().find((candidate) => candidate.url().startsWith(rendererOrigin)),
    Boolean,
    30_000,
  );
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.mediaVault?.browser));
  if (packagedExecutable) {
    const runtime = await app.evaluate(({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(process.getBuiltinModule("path").join(app.getAppPath(), "package.json"));
      // Import the actual staged maintenance dependencies without creating a provider
      // or contacting a release server. Development node_modules must not fill gaps.
      const updater = load("electron-updater");
      const provider = load("electron-updater/out/providers/GitHubProvider.js");
      return {
        isPackaged: app.isPackaged,
        version: app.getVersion(),
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        videos: app.getPath("videos"),
        resourcesPath: process.resourcesPath,
        executable: process.execPath,
        platform: process.platform,
        architecture: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        nativeModules: Object.keys(load.cache).filter((path) =>
          /better-sqlite3[\\/].*\.node$/i.test(path),
        ),
        updaterRuntime: {
          version: load("electron-updater/package.json").version,
          nsis: typeof updater.NsisUpdater === "function",
          github: typeof provider.GitHubProvider === "function",
          module: load.resolve("electron-updater"),
        },
      };
    });
    assert.equal(runtime.isPackaged, true, "test did not launch a packaged application");
    assert.equal(runtime.version, expectedVersion);
    assert.equal(runtime.architecture, "x64");
    assert.equal(runtime.updaterRuntime.nsis, true);
    assert.equal(runtime.updaterRuntime.github, true);
    assert.equal(runtime.updaterRuntime.version, "6.8.9");
    assert.ok(
      runtime.updaterRuntime.module.startsWith(runtime.appPath + sep),
      "app updater loaded outside packaged resources",
    );
    assert.ok(samePath(runtime.executable, packagedExecutable));
    assert.ok(
      samePath(runtime.userData, profilePath),
      "packaged app ignored the isolated profile argument",
    );
    assert.ok(
      samePath(runtime.videos, join(scratch, "videos")),
      "packaged app ignored the isolated media-directory argument",
    );
    assert.ok(samePath(runtime.resourcesPath, packagedResources));
    assert.ok(
      runtime.nativeModules.length > 0,
      "packaged better-sqlite3 native module did not load",
    );
    for (const nativePath of runtime.nativeModules) {
      const local = relative(runtime.resourcesPath, nativePath);
      assert.ok(
        local && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`),
        "native module loaded outside packaged resources",
      );
    }
    applicationPath = runtime.appPath;
    const configuredDownloads = await value("settings", "getDownloads");
    assert.ok(
      insideScratch(configuredDownloads.directory),
      "packaged app uses a download directory outside the isolated fixture",
    );
    if (!savedPackagedRuntime && process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
      await mkdir(resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS), { recursive: true });
      await writeFile(
        join(resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS), "packaged-runtime.json"),
        JSON.stringify(runtime, null, 2),
      );
      savedPackagedRuntime = true;
      console.log(
        "[desktop smoke] Packaged executable, isolated Unicode data path, bundled native SQLite module and restricted system PATH verified.",
      );
    }
  }
  if (!fresh) await page.getByRole("button", { name: "en", exact: true }).click();
  else await value("settings", "update", { homepage: `${origin}/home`, saveSession: true });
}
function insideScratch(path) {
  const local = relative(scratch, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}
async function bridge(group, method, ...args) {
  return page.evaluate(
    async ({ group, method, args }) => window.mediaVault[group][method](...args),
    { group, method, args },
  );
}
async function value(group, method, ...args) {
  const result = await bridge(group, method, ...args);
  assert.equal(result.ok, true, `${group}.${method} failed: ${result.error ?? "unknown"}`);
  return result.value;
}
const persistedDriveSettings = {
  concurrency: 3,
  autoUpload: false,
  deleteLocal: "ask",
  chunkSizeMiB: 4,
};
function publicDriveSnapshot(snapshot) {
  assert.deepEqual(
    Object.keys(snapshot)
      .filter((key) => key !== "error")
      .sort(),
    ["account", "settings", "syncing", "uploads"],
  );
  assert.equal(typeof snapshot.syncing, "boolean");
  const accountFields = new Set([
    "configured",
    "connected",
    "connecting",
    "providerAccountId",
    "email",
    "displayName",
    "storageLimit",
    "storageUsed",
    "rootFolderId",
    "rootFolderName",
    "error",
  ]);
  const uploadFields = new Set([
    "id",
    "mediaId",
    "providerAccountId",
    "fileName",
    "fileSize",
    "mimeType",
    "driveFolderId",
    "driveFileId",
    "uploadedBytes",
    "progress",
    "speed",
    "eta",
    "status",
    "createdAt",
    "updatedAt",
    "startedAt",
    "completedAt",
    "error",
  ]);
  assert.ok(
    Object.keys(snapshot.account).every((key) => accountFields.has(key)),
    "private account field exposed",
  );
  for (const upload of snapshot.uploads)
    assert.ok(
      Object.keys(upload).every((key) => uploadFields.has(key)),
      "private upload field exposed",
    );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /ya29\.|Bearer\s|upload_id=|access_token|refresh_token|sessionEncrypted|plannedFileId|sessionUrl|client_secret/i,
  );
}
async function verifyDisconnectedDrive() {
  const snapshot = await value("drive", "getState");
  publicDriveSnapshot(snapshot);
  assert.deepEqual(snapshot.account, { configured: false, connected: false, connecting: false });
  assert.deepEqual(snapshot.uploads, []);
  assert.deepEqual(snapshot.settings, {
    concurrency: 2,
    autoUpload: false,
    deleteLocal: "never",
    chunkSizeMiB: 8,
  });
  assert.deepEqual(await value("drive", "getAccount"), snapshot.account);
  assert.deepEqual(await value("drive", "listUploads"), []);
  assert.deepEqual(await value("settings", "getDrive"), snapshot.settings);
  assert.deepEqual(await bridge("drive", "connect"), { ok: false, error: "driveNotConfigured" });
  assert.deepEqual(await bridge("drive", "upload", "C:\\untrusted\\movie.mp4"), {
    ok: false,
    error: "invalidInput",
  });
  assert.deepEqual(
    await bridge("settings", "updateDrive", { ...snapshot.settings, concurrency: 4 }),
    { ok: false, error: "invalidInput" },
  );
  assert.deepEqual(
    await bridge("settings", "updateDrive", { ...snapshot.settings, sessionUrl: "forbidden" }),
    { ok: false, error: "invalidInput" },
  );
  await page.evaluate(() => {
    window.__smokeDrive = [];
    window.__smokeStopDrive = window.mediaVault.drive.onChanged((state) =>
      window.__smokeDrive.push(state),
    );
  });
  assert.deepEqual(
    await value("settings", "updateDrive", persistedDriveSettings),
    persistedDriveSettings,
  );
  const changed = await until(
    "Drive settings event",
    () => page.evaluate(() => window.__smokeDrive.at(-1)),
    (state) => state?.settings?.concurrency === 3,
  );
  publicDriveSnapshot(changed);
  await page.evaluate(() => window.__smokeStopDrive());
  await page.getByRole("link", { name: label("nav.drive"), exact: true }).click();
  await page.getByText(label("drive.notConnected"), { exact: true }).first().waitFor();
  await page
    .getByText(label("desktop.errors.driveNotConfigured"), { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: label("drive.connect"), exact: true }).isDisabled(),
    true,
  );
  for (const key of ["storageLimit", "storageUsed", "email", "providerAccountId"])
    assert.equal(
      snapshot.account[key],
      undefined,
      "disconnected state invented an account or quota",
    );
  await page.getByRole("button", { name: "vi", exact: true }).click();
  await page.getByText(label("drive.notConnected", "vi"), { exact: true }).first().waitFor();
  await page
    .getByText(label("desktop.errors.driveNotConfigured", "vi"), { exact: true })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "en", exact: true }).click();
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    const destination = resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS);
    await mkdir(destination, { recursive: true });
    await page.screenshot({ path: join(destination, "desktop-drive.png") });
  }
  await page.getByRole("link", { name: label("nav.settings"), exact: true }).click();
  await page.getByRole("button", { name: label("settings.saveDrive"), exact: true }).waitFor();
  const automatic = page.getByRole("switch", { name: label("settings.autoUpload"), exact: true });
  assert.equal(await automatic.getAttribute("aria-checked"), "false");
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
  console.log(
    "[desktop smoke] Credential-free Drive state, defaults/settings events, EN/VI, private DTO boundaries and validation verified.",
  );
}
async function state() {
  return value("browser", "getState");
}
async function loaded(path) {
  return until(
    `browser navigation to ${path}`,
    state,
    (current) => current.url === `${origin}${path}` && !current.loading,
  );
}
async function navigate(path) {
  const address = page.getByRole("textbox", { name: label("desktop.address"), exact: true });
  const current = await state();
  await until(
    "browser address hydrated before navigation",
    () => address.inputValue(),
    (url) => url === current.url,
  );
  await address.fill(`${origin}${path}`);
  await page.getByRole("button", { name: label("browser.go"), exact: true }).click();
  return loaded(path);
}
async function saveSession(enabled) {
  await page.getByRole("link", { name: label("nav.settings"), exact: true }).click();
  const toggle = page.getByRole("switch", { name: label("settings.session"), exact: true });
  await until("session setting is loaded", () => toggle.isEnabled());
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
  await page.getByRole("button", { name: label("desktop.save"), exact: true }).click();
  await page.getByText(label("desktop.saved"), { exact: true }).waitFor();
  assert.equal((await value("settings", "get")).saveSession, enabled);
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
  await loaded("/home");
  await assertBounds();
}
async function clearBrowserData() {
  await page.getByRole("link", { name: label("nav.settings"), exact: true }).click();
  await page.getByRole("button", { name: label("settings.clearData"), exact: true }).click();
  await page.getByText(label("desktop.clearedData"), { exact: true }).waitFor();
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
  await loaded("/home");
  await assertBounds();
}
async function remote(script) {
  return app.evaluate(
    async ({ webContents }, { origin, script }) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(origin));
      if (!view) throw new Error("Fixture browser WebContents was not found");
      return view.executeJavaScript(script, true);
    },
    { origin, script },
  );
}
async function geometry() {
  return app.evaluate(({ BrowserWindow, webContents }, origin) => {
    const host = BrowserWindow.getAllWindows()[0];
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL().startsWith(origin));
    const view = host.contentView.children.find((item) => item.webContents?.id === contents?.id);
    return {
      attached: Boolean(view),
      visible: view?.getVisible() ?? false,
      bounds: view?.getBounds() ?? null,
      window: host.getContentBounds(),
    };
  }, origin);
}
async function assertBounds() {
  return until(
    "native browser bounds match the measured viewport",
    async () => {
      const native = await geometry();
      const slot = await page.locator("[data-browser-viewport]").boundingBox();
      return { native, slot };
    },
    ({ native, slot }) =>
      native.attached &&
      native.visible &&
      slot &&
      ["x", "y", "width", "height"].every((key) => Math.abs(native.bounds[key] - slot[key]) <= 2),
  );
}
async function firstRunSmoke() {
  await launch("onboarding-profile", undefined, { fresh: true });
  const welcome = () => page.getByRole("dialog", { name: label("onboarding.title"), exact: true });
  await welcome().waitFor();
  await until(
    "onboarding hides the native browser view",
    geometry,
    (view) =>
      !view.attached || !view.visible || view.bounds.width === 0 || view.bounds.height === 0,
  );
  const initial = await value("settings", "getProduct");
  assert.equal(initial.firstLaunchCompleted, false);
  assert.equal(initial.startWithWindows, false, "fresh launch must not register Windows startup");
  assert.equal(initial.closeBehavior, "tray");
  assert.equal(initial.trayAvailable, true);
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    const destination = resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS);
    await mkdir(destination, { recursive: true });
    await page.screenshot({ path: join(destination, "desktop-onboarding.png") });
  }
  // An interrupted wizard must remain unfinished even after ordinary settings exist.
  await close();
  await launch("onboarding-profile", undefined, { fresh: true });
  await welcome().waitFor();
  assert.equal((await value("settings", "getProduct")).firstLaunchCompleted, false);
  await welcome().getByRole("button", { name: "Tiếng Việt", exact: true }).click();
  const vietnamese = page.getByRole("dialog", {
    name: label("onboarding.title", "vi"),
    exact: true,
  });
  await vietnamese.waitFor();
  await vietnamese.getByRole("button", { name: "English", exact: true }).click();
  await welcome()
    .getByRole("button", { name: label("onboarding.next"), exact: true })
    .click();
  await welcome().getByText(label("onboarding.steps.folder"), { exact: true }).waitFor();
  const directory = join(scratch, "onboarding-downloads");
  await mkdir(directory, { recursive: true });
  await picker([directory]);
  await welcome()
    .getByRole("button", { name: label("common.browse"), exact: true })
    .click();
  await welcome().getByText(directory, { exact: true }).waitFor();
  await welcome()
    .getByRole("button", { name: label("onboarding.next"), exact: true })
    .click();
  await welcome()
    .getByRole("button", { name: label("downloadDialog.quality.1080"), exact: true })
    .click();
  await welcome()
    .getByRole("button", { name: label("onboarding.next"), exact: true })
    .click();
  await welcome()
    .getByRole("button", { name: label("downloadDialog.container.mkv"), exact: true })
    .click();
  await welcome()
    .getByRole("button", { name: label("onboarding.next"), exact: true })
    .click();
  assert.equal(
    await welcome()
      .getByRole("button", { name: label("drive.connect"), exact: true })
      .isDisabled(),
    true,
  );
  await welcome()
    .getByRole("button", { name: label("onboarding.skip"), exact: true })
    .click();
  assert.equal(
    await welcome()
      .getByRole("switch", { name: label("settings.startWin"), exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
  await welcome()
    .getByRole("button", { name: label("product.close.tray"), exact: true })
    .click();
  await welcome()
    .getByRole("button", { name: label("onboarding.finish"), exact: true })
    .click();
  await welcome().waitFor({ state: "hidden" });
  const completed = await value("settings", "getProduct");
  assert.equal(completed.firstLaunchCompleted, true);
  assert.equal(completed.startWithWindows, false);
  assert.equal(completed.closeBehavior, "tray");
  const downloads = await value("settings", "getDownloads");
  assert.equal(downloads.directory, directory);
  assert.equal(downloads.quality, "1080");
  assert.equal(downloads.container, "mkv");
  assert.equal((await value("drive", "getAccount")).connected, false);
  await close();
  await launch("onboarding-profile");
  assert.equal((await value("settings", "getProduct")).firstLaunchCompleted, true);
  assert.equal((await value("settings", "getDownloads")).directory, directory);
  assert.equal(await welcome().count(), 0, "completed wizard reopened after restart");
  await close();
  console.log(
    "[desktop smoke] Fresh/interrupted/completed onboarding, real folder approval, quality/format persistence, optional Drive and startup-off verified.",
  );
}
async function close() {
  if (!app) return;
  const closing = app;
  // The test owns this isolated profile and approves the native exit prompt,
  // including teardown after a failed assertion while a worker is still active.
  await closing
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    })
    .catch(() => {});
  const exited = closing.waitForEvent("close", { timeout: 30_000 });
  if (page && !page.isClosed())
    await page
      .evaluate(() => {
        void window.mediaVault.window.exit();
      })
      .catch(() => {});
  else await closing.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  app = undefined;
  page = undefined;
}
async function verifyAnalysisError(binaryPath, expected, profile) {
  await launch(profile, binaryPath);
  await navigate("/analysis");
  const result = await bridge("browser", "scan");
  const current = await until(
    `${expected} analysis error`,
    state,
    (item) => !item.scanning && item.error === expected,
    50_000,
  );
  assert.equal(current.analysis, null);
  if (!result.ok) assert.equal(result.error, expected);
  assert.equal((await value("binaries", "status")).available, false);
  await close();
}

async function jobs() {
  return value("downloads", "list");
}
async function jobState(id, expected) {
  return until(
    `download ${id} becomes ${expected}`,
    async () => {
      const job = (await jobs()).find((item) => item.id === id);
      assert.ok(job, "download disappeared");
      if (job.status === "failed") throw new Error(`Download failed: ${job.error}`);
      return job;
    },
    (job) => job.status === expected,
    60_000,
  );
}
async function scanFixture(path) {
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
  await assertBounds();
  const current = await state();
  await until(
    "browser address hydrated after route mount",
    () => page.getByRole("textbox", { name: label("desktop.address"), exact: true }).inputValue(),
    (url) => url === current.url,
  );
  await navigate(path);
  await value("browser", "scan");
  const result = await until(
    "fixture scan",
    state,
    (item) => !item.scanning && Boolean(item.analysis || item.error),
    50_000,
  );
  assert.equal(result.error, null);
  return result.analysis.formats[0];
}
async function addFixture(candidate, title, container = "mp4") {
  const settings = await value("settings", "getDownloads");
  return value("downloads", "add", {
    mediaId: candidate.id,
    quality: "best",
    container,
    destinationDirectory: settings.directory,
    title,
  });
}
async function picker(paths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);
}
async function assertCookieFilesRemoved() {
  assert.equal(
    (await readdir(cookieDirectory())).length,
    0,
    "temporary browser cookie files survived an operation",
  );
}
function assertNoCookieMaterial(value, boundary) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(authCookieValue), false, `${boundary} exposed a cookie value`);
  assert.equal(text.includes(authCookieName), false, `${boundary} exposed cookie material`);
  assert.equal(
    text.includes("browser-cookie-temp"),
    false,
    `${boundary} exposed the cookie directory`,
  );
  assert.equal(
    /cookie-[a-f0-9-]{36}\.txt/i.test(text),
    false,
    `${boundary} exposed a temporary cookie filename`,
  );
}
async function verifyCookiePrivacy() {
  for (const [name, data] of [
    ["Browser DTO", await state()],
    ["Download DTO", await jobs()],
    ["Library DTO", await value("library", "list")],
    ["Activity DTO", await value("activity", "list")],
  ])
    assertNoCookieMaterial(data, name);
  const profile = join(scratch, "persistent-profile");
  const database = new Database(join(profile, "mediavault.db"), { readonly: true });
  try {
    for (const { name } of database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const escaped = name.replaceAll('"', '""');
      assertNoCookieMaterial(database.prepare(`SELECT * FROM "${escaped}"`).all(), "SQLite rows");
    }
  } finally {
    database.close();
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const data = await readFile(join(profile, `mediavault.db${suffix}`)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (data) assertNoCookieMaterial(data.toString("utf8"), "SQLite files");
  }
  const logs = join(profile, "logs");
  for (const entry of await readdir(logs, { withFileTypes: true }))
    if (entry.isFile())
      assertNoCookieMaterial(await readFile(join(logs, entry.name), "utf8"), "Application logs");
}
async function storageSmoke() {
  const snapshot = await value("storage", "get");
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "database",
    "downloads",
    "fingerprintEnabled",
    "logs",
    "temp",
    "thumbnails",
  ]);
  for (const category of ["downloads", "temp", "thumbnails", "database", "logs"])
    assert.ok(
      Number.isFinite(snapshot[category]) && snapshot[category] >= 0,
      `Invalid ${category} byte count`,
    );
  assert.ok(snapshot.database > 0, "storage omitted the real database files");
  assert.equal(snapshot.fingerprintEnabled, false);
  assert.equal((await value("storage", "setFingerprintEnabled", true)).fingerprintEnabled, true);
  assert.equal((await value("storage", "get")).fingerprintEnabled, true);
  const database = new Database(join(scratch, "persistent-profile", "mediavault.db"), {
    readonly: true,
  });
  try {
    const row = database.prepare("SELECT value_json FROM settings WHERE key=?").get("storage");
    assert.equal(JSON.parse(row.value_json).fingerprintEnabled, true);
  } finally {
    database.close();
  }
  assert.equal((await value("storage", "setFingerprintEnabled", false)).fingerprintEnabled, false);
  for (const [method, input] of [
    ["clean", "downloads"],
    ["setFingerprintEnabled", "true"],
  ])
    assert.deepEqual(await bridge("storage", method, input), { ok: false, error: "invalidInput" });

  const tempRoot = join(scratch, "videos", "MediaVault", "Temp");
  const orphan = join(tempRoot, randomUUID());
  const partial = join(orphan, "media.mp4.part");
  const sentinel = join(tempRoot, "smoke-sentinel.txt");
  await mkdir(orphan, { recursive: true });
  await writeFile(partial, "generated orphan fixture");
  await writeFile(sentinel, "preserve non-owned fixture");
  const old = new Date(Date.now() - 2 * 86_400_000);
  await utimes(partial, old, old);
  await utimes(orphan, old, old);
  const cleaned = await value("storage", "clean", "staleTemp");
  assert.ok(cleaned.database > 0);
  await assert.rejects(
    access(orphan),
    (error) => error.code === "ENOENT",
    "stale orphan staging survived cleanup",
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve non-owned fixture");
  console.log(
    "[desktop smoke] Real storage byte counts, persisted fingerprint preference, strict controls and safe orphan cleanup verified.",
  );
}

async function diagnosticsSmoke() {
  await page.getByRole("link", { name: label("nav.settings"), exact: true }).click();
  const diagnostics = page.locator("section").filter({
    has: page.getByRole("heading", { name: label("diagnostics.title"), exact: true }),
  });
  await diagnostics
    .getByRole("button", { name: label("diagnostics.refresh"), exact: true })
    .waitFor();
  const maintenance = await value("maintenance", "get");
  const binaries = await value("binaries", "getStatus");
  const notices = JSON.parse(await readFile(join(root, "resources/notices/binaries.json"), "utf8"));
  assert.equal(maintenance.ytDlp.currentVersion, binaries.ytDlp.version);
  assert.equal(
    maintenance.ytDlp.latestVersion,
    null,
    "startup unexpectedly checked yt-dlp updates",
  );
  assert.equal(maintenance.ytDlp.available, false);
  assert.equal(
    maintenance.ffmpegSource,
    notices.binaries.find((binary) => binary.file === "ffmpeg.exe").buildSourceUrl,
  );
  await until(
    "Settings displays the current yt-dlp version",
    () =>
      page.getByText(label("maintenance.ytCurrent"), { exact: true }).locator("..").textContent(),
    (text) => text.includes(binaries.ytDlp.version),
  );
  await page.getByText(maintenance.ffmpegSource, { exact: true }).waitFor();
  assert.deepEqual(maintenance.app, {
    configured: false,
    currentVersion: expectedVersion,
    latestVersion: null,
    status: "unconfigured",
  });
  await page.getByText(label("maintenance.appStatus.unconfigured"), { exact: true }).waitFor();
  for (const [method, key] of [
    ["checkApp", "maintenance.checkApp"],
    ["downloadApp", "maintenance.downloadApp"],
    ["installApp", "maintenance.installApp"],
  ]) {
    assert.equal(
      await page.getByRole("button", { name: label(key), exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(await bridge("maintenance", method), {
      ok: false,
      error: "updateNotConfigured",
    });
  }
  assert.deepEqual((await value("maintenance", "get")).app, maintenance.app);
  assert.equal(
    await page.getByText(label("maintenance.appStatus.current"), { exact: true }).count(),
    0,
  );

  const snapshot = await value("diagnostics", "get");
  const runtime = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
  }));
  assert.equal(snapshot.appVersion, runtime.version);
  assert.equal(snapshot.electronVersion, runtime.electron);
  assert.equal(snapshot.nodeVersion, runtime.node);
  assert.equal(snapshot.platform, runtime.platform);
  assert.equal(snapshot.architecture, runtime.architecture);
  assert.deepEqual(snapshot.binaries, binaries);
  assert.equal(snapshot.driveConnected, false);
  assert.equal(
    snapshot.browserSession,
    (await value("settings", "get")).saveSession ? "persistent" : "temporary",
  );
  assert.equal(
    snapshot.activeDownloads,
    (await jobs()).filter((job) =>
      ["queued", "analyzing", "downloading", "processing"].includes(job.status),
    ).length,
  );
  assert.equal(
    snapshot.activeUploads,
    (await value("drive", "getState")).uploads.filter((job) =>
      ["queued", "preparing", "uploading", "finalizing"].includes(job.status),
    ).length,
  );
  assert.ok(Number.isSafeInteger(snapshot.availableDiskSpace) && snapshot.availableDiskSpace >= 0);
  assert.ok(samePath(snapshot.databasePath, join(scratch, "persistent-profile", "mediavault.db")));
  assert.ok(samePath(snapshot.downloadFolder, (await value("settings", "getDownloads")).directory));
  const database = new Database(snapshot.databasePath, { readonly: true });
  try {
    assert.equal(snapshot.schemaVersion, database.pragma("user_version", { simple: true }));
  } finally {
    database.close();
  }
  assertNoCookieMaterial(snapshot, "Diagnostic snapshot");
  await until(
    "Settings renders actual diagnostic platform",
    () =>
      diagnostics
        .getByText(label("diagnostics.fields.platform"), { exact: true })
        .locator("..")
        .locator("dd")
        .textContent(),
    (text) => text === runtime.platform,
  );

  // An invalid input exercises the real IPC logger without writing raw sentinels to a log fixture.
  const sentinel = `diagnostic-private-${randomUUID()}`;
  assert.deepEqual(await bridge("diagnostics", "logs", { component: sentinel }), {
    ok: false,
    error: "invalidInput",
  });
  const errors = await value("diagnostics", "logs", { component: "ipc", kind: "error" });
  assert.ok(errors.some((entry) => entry.code === "invalidInput"));
  assert.ok(
    errors.every((entry) => entry.component === "ipc" && entry.code && entry.event === null),
  );
  const events = await value("diagnostics", "logs", { component: "browser", kind: "event" });
  assert.ok(events.some((entry) => entry.event === "authAnalysisRetry"));
  assert.ok(
    events.every((entry) => entry.component === "browser" && entry.event && entry.code === null),
  );
  const allLogs = await value("diagnostics", "logs");
  assert.ok(allLogs.length > 0 && allLogs.length <= 200);
  for (const entry of allLogs) {
    assert.deepEqual(Object.keys(entry).sort(), ["code", "component", "event", "id", "time"]);
    assert.match(entry.id, /^[a-f0-9]{64}$/);
  }
  assertNoCookieMaterial(allLogs, "Diagnostic logs");
  assert.equal(JSON.stringify(allLogs).includes(sentinel), false);
  for (const entry of await readdir(join(scratch, "persistent-profile", "logs"), {
    withFileTypes: true,
  }))
    if (entry.isFile())
      assert.equal(
        (await readFile(join(scratch, "persistent-profile", "logs", entry.name), "utf8")).includes(
          sentinel,
        ),
        false,
        "IPC input was written verbatim to a log",
      );

  const exportDirectory = join(scratch, "diagnostic-exports");
  await mkdir(exportDirectory);
  const exportPath = join(exportDirectory, "MediaVault-diagnostics.json");
  // Intercept only the native clipboard write; the real renderer/IPC sanitizer still supplies it.
  // Existing user clipboard formats remain untouched.
  await app.evaluate(({ clipboard, dialog }) => {
    globalThis.__mvDiagnosticsSmoke = {
      writeClipboard: clipboard.writeText,
      copiedText: null,
      saveDialog: dialog.showSaveDialog,
      exportPath: null,
      chooserCalls: [],
    };
    clipboard.writeText = (text) => {
      globalThis.__mvDiagnosticsSmoke.copiedText = text;
    };
    dialog.showSaveDialog = async (_window, options) => {
      const fixture = globalThis.__mvDiagnosticsSmoke;
      fixture.chooserCalls.push({ title: options.title, filters: options.filters });
      return fixture.exportPath === null
        ? { canceled: true }
        : { canceled: false, filePath: fixture.exportPath };
    };
  });
  try {
    await diagnostics
      .getByRole("combobox", { name: label("diagnostics.component"), exact: true })
      .selectOption("ipc");
    await diagnostics
      .getByRole("combobox", { name: label("diagnostics.kind"), exact: true })
      .selectOption("error");
    const radios = diagnostics.getByRole("radio");
    await until(
      "filtered diagnostic rows",
      () => radios.count(),
      (count) => count > 0,
    );
    await radios.first().check();
    await diagnostics.getByRole("button", { name: label("diagnostics.copy"), exact: true }).click();
    await diagnostics.getByText(label("diagnostics.copied"), { exact: true }).waitFor();
    const copied = JSON.parse(await app.evaluate(() => globalThis.__mvDiagnosticsSmoke.copiedText));
    assert.ok(errors.some((entry) => entry.id === copied.id));
    assert.deepEqual(Object.keys(copied).sort(), ["code", "component", "event", "id", "time"]);
    assertNoCookieMaterial(copied, "Copied diagnostic entry");
    assert.equal(JSON.stringify(copied).includes(sentinel), false);

    assert.equal(
      await value("diagnostics", "exportDiagnostics"),
      false,
      "cancelled native save picker reported success",
    );
    await diagnostics
      .getByRole("button", { name: label("diagnostics.exportTitle"), exact: true })
      .click();
    await until(
      "cancelled export reaches the native chooser",
      () => app.evaluate(() => globalThis.__mvDiagnosticsSmoke.chooserCalls.length),
      (count) => count === 2,
    );
    await until("cancelled export action settles", () =>
      diagnostics
        .getByRole("button", { name: label("diagnostics.exportTitle"), exact: true })
        .isEnabled(),
    );
    assert.equal(
      await diagnostics.getByText(label("diagnostics.exported"), { exact: true }).count(),
      0,
    );
    assert.deepEqual(await readdir(exportDirectory), []);

    await app.evaluate((_electron, path) => {
      globalThis.__mvDiagnosticsSmoke.exportPath = path;
    }, exportPath);
    await diagnostics
      .getByRole("button", { name: label("diagnostics.exportTitle"), exact: true })
      .click();
    await diagnostics.getByText(label("diagnostics.exported"), { exact: true }).waitFor();
    const exportedText = await readFile(exportPath, "utf8");
    const exported = JSON.parse(exportedText);
    assert.deepEqual(Object.keys(exported).sort(), [
      "activeDownloads",
      "activeUploads",
      "appVersion",
      "architecture",
      "availableDiskSpace",
      "binaries",
      "browserSession",
      "createdAt",
      "driveConnected",
      "electronVersion",
      "formatVersion",
      "jobStatuses",
      "logs",
      "nodeVersion",
      "platform",
      "schemaVersion",
      "settings",
    ]);
    assert.equal(exported.formatVersion, 1);
    assert.equal(exported.appVersion, expectedVersion);
    assert.equal(exported.schemaVersion, snapshot.schemaVersion);
    const countStates = (rows, states) =>
      Object.fromEntries(
        states.map((status) => [status, rows.filter((row) => row.status === status).length]),
      );
    assert.deepEqual(exported.jobStatuses, {
      downloads: countStates(await jobs(), [
        "queued",
        "analyzing",
        "downloading",
        "processing",
        "paused",
        "completed",
        "failed",
        "cancelled",
      ]),
      uploads: countStates((await value("drive", "getState")).uploads, [
        "queued",
        "preparing",
        "uploading",
        "finalizing",
        "paused",
        "completed",
        "failed",
        "cancelled",
      ]),
    });
    assert.deepEqual(exported.binaries, binaries);
    assert.deepEqual(exported.settings, snapshot.settings);
    assert.ok(exported.logs.length > 0);
    assertNoCookieMaterial(exportedText, "Exported diagnostics");
    for (const privateValue of [
      sentinel,
      scratch,
      snapshot.databasePath,
      snapshot.downloadFolder,
      exportPath,
    ])
      assert.equal(
        exportedText.includes(privateValue) ||
          exportedText.includes(JSON.stringify(privateValue).slice(1, -1)),
        false,
        "diagnostic export exposed private input or a local path",
      );
    assert.doesNotMatch(
      exportedText,
      /ya29\.|Bearer\s|access_token|refresh_token|client_secret|sessionEncrypted|plannedFileId|sessionUrl/i,
    );
    const chooserCalls = await app.evaluate(() => globalThis.__mvDiagnosticsSmoke.chooserCalls);
    assert.ok(chooserCalls.length >= 3);
    assert.ok(
      chooserCalls.every(
        (call) =>
          call.title === label("diagnostics.exportTitle") &&
          call.filters.some((filter) => filter.extensions.includes("json")),
      ),
    );

    if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
      const destination = resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS);
      await diagnostics.screenshot({ path: join(destination, "desktop-diagnostics.png") });
      await page
        .locator("section")
        .filter({
          has: page.getByRole("heading", { name: label("maintenance.appTitle"), exact: true }),
        })
        .screenshot({ path: join(destination, "desktop-app-updates.png") });
    }

    await diagnostics
      .getByRole("button", { name: label("diagnostics.clear"), exact: true })
      .click();
    await diagnostics.getByText(label("diagnostics.cleared"), { exact: true }).waitFor();
    assert.deepEqual(await value("diagnostics", "logs"), []);
    assert.equal(await radios.count(), 0);
    assert.equal(
      await diagnostics
        .getByRole("button", { name: label("diagnostics.copy"), exact: true })
        .isDisabled(),
      true,
    );
  } finally {
    await app.evaluate(({ clipboard, dialog }) => {
      const fixture = globalThis.__mvDiagnosticsSmoke;
      dialog.showSaveDialog = fixture.saveDialog;
      clipboard.writeText = fixture.writeClipboard;
      delete globalThis.__mvDiagnosticsSmoke;
    });
    await value("diagnostics", "clearLogs");
  }
  await verifyCookiePrivacy();
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
  console.log(
    "[desktop smoke] Real maintenance versions/source, unconfigured updater errors, diagnostic OS/schema/counts, safe log filtering/copy/clear and cancelled/successful private-free native JSON export verified.",
  );
}
async function authenticatedDownloadSmoke() {
  await navigate("/login");
  assert.equal(
    await remote(`document.cookie.includes('${authCookieName}=')`),
    false,
    "HttpOnly fixture cookie was readable by the website",
  );
  // No test-owned CDP attachment may overlap Main's short cookie-metadata attachment.
  assert.equal(
    await app.evaluate(
      ({ webContents }, origin) =>
        webContents
          .getAllWebContents()
          .find((item) => item.getURL().startsWith(origin))
          .debugger.isAttached(),
      origin,
    ),
    false,
  );
  const requestStart = authRequests.length;
  const candidate = await scanFixture("/protected-video");
  assert.equal(
    candidate.requiresBrowserSession,
    true,
    "authenticated analysis did not mark its trusted media candidate",
  );
  const scanRequests = authRequests
    .slice(requestStart)
    .filter((request) => request.path === "/protected-video");
  assert.ok(
    scanRequests.some((request) => !request.authorized),
    "analysis did not attempt the public page before auth fallback",
  );
  assert.ok(
    scanRequests.some((request) => request.authorized),
    "analysis never used the browser session",
  );
  await assertCookieFilesRemoved();
  const first = await addFixture(candidate, "Smoke authenticated download");
  assert.equal(
    first.requiresBrowserSession,
    true,
    "persisted download lost its session requirement",
  );
  const completed = await jobState(first.id, "completed");
  assert.ok((await stat(completed.outputPath)).size > 0);
  assert.ok(
    authRequests.some((request) => request.path === "/protected.mp4" && request.authorized),
  );
  await assertCookieFilesRemoved();
  const log = join(scratch, "persistent-profile", "logs", "mediavault.log");
  await until(
    "sanitized authenticated-operation events",
    () => readFile(log, "utf8"),
    (text) => text.includes('"authAnalysisRetry"') && text.includes('"authDownloadUsed"'),
  );
  await verifyCookiePrivacy();

  // Pause a real transfer, clear only the browser session, and resume the persisted job.
  // It must stop safely instead of downloading anonymously or discarding partial bytes.
  slowAuthMedia = true;
  const interrupted = await addFixture(candidate, "Smoke authenticated resume");
  await until(
    "authenticated download progress",
    async () => (await jobs()).find((job) => job.id === interrupted.id),
    (job) => job.status === "downloading" && job.downloadedBytes >= 8192,
    60_000,
  );
  assert.ok(
    (await readdir(cookieDirectory())).some((name) => /^cookie-[a-f0-9-]{36}\.txt$/.test(name)),
    "active authenticated download had no isolated cookie file",
  );
  await verifyCookiePrivacy();
  await value("downloads", "pause", interrupted.id);
  const paused = await jobState(interrupted.id, "paused");
  await assertCookieFilesRemoved();
  await value("settings", "clearCookies");
  await loaded("/home");
  await value("downloads", "resume", interrupted.id);
  const needsSession = await until(
    "session-dependent download safely pauses after cookie clearing",
    async () => (await jobs()).find((job) => job.id === interrupted.id),
    (job) => job.status === "paused" && job.error === "browserSessionRequired",
    30_000,
  );
  assert.equal(needsSession.requiresBrowserSession, true);
  assert.ok(
    needsSession.downloadedBytes >= paused.downloadedBytes,
    "session clearing discarded persisted partial progress",
  );
  assert.equal(needsSession.outputPath, undefined);
  await assertCookieFilesRemoved();
  await navigate("/login");
  await value("downloads", "resume", interrupted.id);
  await jobState(interrupted.id, "completed");
  slowAuthMedia = false;
  await assertCookieFilesRemoved();
  await verifyCookiePrivacy();
  const database = new Database(join(scratch, "persistent-profile", "mediavault.db"), {
    readonly: true,
  });
  try {
    const row = database
      .prepare("SELECT requires_browser_session, status FROM downloads WHERE id = ?")
      .get(interrupted.id);
    assert.equal(row.requires_browser_session, 1);
    assert.equal(row.status, "completed");
  } finally {
    database.close();
  }
  await value("downloads", "clearCompleted");
  assert.deepEqual(await jobs(), []);
  await navigate("/home");
  console.log(
    "[desktop smoke] Local HttpOnly login, real public-to-auth analysis retry, authenticated download, cookie-jar cleanup/privacy, safe session-loss pause and reauthentication resume verified.",
  );
}

async function phaseTwoSmoke() {
  const binaries = await value("binaries", "getStatus");
  for (const name of ["ytDlp", "ffmpeg", "ffprobe"])
    assert.equal(
      binaries[name].state,
      "ready",
      `${name} setup is required for real download smoke`,
    );
  assert.deepEqual(await jobs(), []);
  assert.deepEqual(await value("library", "list"), []);
  assert.deepEqual(await value("activity", "list"), []);
  const settings = await value("settings", "getDownloads");
  assert.ok(settings.directory.startsWith(join(scratch, "videos")));
  await value("settings", "updateDownloads", { ...settings, concurrency: 1, autoRetry: false });
  await page.evaluate(() => {
    window.__smokeDownloads = [];
    window.mediaVault.downloads.onChanged((jobs) => window.__smokeDownloads.push(jobs));
  });

  // Exercise the actual Browser -> options dialog -> native chooser -> queue flow.
  await scanFixture("/analysis");
  await page
    .getByRole("button", { name: label("common.download"), exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: label("downloadDialog.title"), exact: true });
  await dialog
    .getByRole("textbox", { name: label("downloadDialog.name"), exact: true })
    .fill("Smoke remux");
  await dialog.getByRole("combobox", { name: label("addUrl.container"), exact: true }).click();
  await page
    .getByRole("option", { name: label("downloadDialog.container.mkv"), exact: true })
    .click();
  const chosen = join(scratch, "selected-downloads");
  await mkdir(chosen);
  await picker([chosen]);
  await dialog.getByRole("button", { name: label("common.browse"), exact: true }).click();
  await dialog.getByText(chosen, { exact: true }).waitFor();
  await until("download dialog hides native browser", geometry, (native) => !native.visible);
  await dialog.getByRole("button", { name: label("downloadDialog.queue"), exact: true }).click();
  const queued = await until(
    "download is persisted from dialog",
    jobs,
    (items) => items.length === 1,
  );
  await page.getByRole("link", { name: label("nav.downloads"), exact: true }).click();
  await page.getByText("Smoke remux", { exact: true }).first().waitFor();
  const completed = await jobState(queued[0].id, "completed");
  assert.equal(completed.progress, 100);
  assert.ok(completed.outputPath.endsWith(".mkv"), "chosen container did not run remux");
  assert.equal(dirname(completed.outputPath), chosen);
  assert.ok((await stat(completed.outputPath)).size > 0);
  const probe = JSON.parse(
    (
      await runExecutable(
        executable("ffprobe"),
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", completed.outputPath],
        { windowsHide: true, timeout: 15_000 },
      )
    ).stdout,
  );
  assert.match(probe.format.format_name, /matroska/);
  assert.ok(probe.streams.some((stream) => stream.codec_name === "h264" && stream.width === 320));
  assert.ok(probe.streams.some((stream) => stream.codec_name === "aac"));
  const media = (await value("library", "list")).find((item) => item.id === completed.mediaId);
  assert.equal(media.downloadId, completed.id);
  assert.equal(media.localPath, completed.outputPath);
  assert.equal(media.width, 320);
  assert.equal(media.height, 180);
  assert.ok(media.duration >= 2.9 && media.duration <= 3.2);
  assert.equal(media.fileSize, (await stat(completed.outputPath)).size);
  assert.ok((await stat(media.thumbnailPath)).size > 0);
  const database = new Database(join(scratch, "persistent-profile", "mediavault.db"), {
    readonly: true,
  });
  try {
    assert.deepEqual(
      database.prepare("SELECT status, media_id FROM downloads WHERE id = ?").get(completed.id),
      { status: "completed", media_id: media.id },
    );
    assert.equal(
      database.prepare("SELECT local_path FROM media WHERE id = ?").get(media.id).local_path,
      completed.outputPath,
    );
  } finally {
    database.close();
  }
  await until("download snapshot reaches renderer", () =>
    page.evaluate(() =>
      window.__smokeDownloads.some((items) => items.some((item) => item.status === "completed")),
    ),
  );
  await page.getByRole("link", { name: label("nav.library"), exact: true }).click();
  await page.getByText("Smoke remux", { exact: true }).first().waitFor();
  await until("real thumbnail is loaded", () =>
    page
      .locator('img[src^="mediavault://media/"]')
      .first()
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  console.log(
    "[desktop smoke] Real download, remux, metadata, thumbnail, SQLite and live Library verified.",
  );

  const hlsCandidate = await scanFixture("/hls-analysis");
  assert.equal(hlsCandidate.type, "hls");
  const hlsJob = await addFixture(hlsCandidate, "Smoke HLS");
  const hlsCompleted = await jobState(hlsJob.id, "completed");
  const hlsMedia = (await value("library", "list")).find(
    (item) => item.id === hlsCompleted.mediaId,
  );
  assert.equal(hlsMedia.videoCodec, "h264");
  assert.equal(hlsMedia.audioCodec, "aac");
  assert.equal(hlsMedia.width, 320);
  assert.ok(hlsMedia.duration > 2.9);
  assert.ok(
    requests.get("/hls/segment-00.ts") > 0,
    "HLS downloader never requested media segments",
  );
  console.log(
    "[desktop smoke] Generated local HLS manifest and segments downloaded and probed into Library.",
  );

  // Slow local media makes pause/cancel observable without external websites.
  const slow = await scanFixture("/slow-analysis");
  const pausedJob = await addFixture(slow, "Smoke resume");
  await until(
    "real download progress before pause",
    async () => (await jobs()).find((item) => item.id === pausedJob.id),
    (job) => job.status === "downloading" && job.downloadedBytes >= 8192,
    60_000,
  );
  const product = await value("settings", "getProduct");
  assert.equal(product.closeBehavior, "tray");
  assert.equal(product.trayAvailable, true, "system tray initialization failed");
  const backgroundBefore = (await jobs()).find((item) => item.id === pausedJob.id).downloadedBytes;
  await page.getByRole("button", { name: label("desktop.window.close"), exact: true }).click();
  await until("titlebar close hides the window to tray", () =>
    app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()),
  );
  await until(
    "download continues while hidden to tray",
    async () => (await jobs()).find((item) => item.id === pausedJob.id),
    (job) => job.downloadedBytes > backgroundBefore,
    30_000,
  );
  // Exercise the native activation event that restores an existing hidden window.
  await app.evaluate(({ app }) => app.emit("second-instance", {}, [], process.cwd(), {}));
  await until("native activation reopens the hidden window", () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
  );
  assert.equal((await value("settings", "getProduct")).firstLaunchCompleted, true);
  await value("downloads", "pause", pausedJob.id);
  const paused = await jobState(pausedJob.id, "paused");
  assert.ok(paused.downloadedBytes > 0);
  await page.getByRole("link", { name: label("nav.downloads"), exact: true }).click();
  await page.getByText("Smoke resume", { exact: true }).first().waitFor();
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    await page.screenshot({
      path: join(resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS), "desktop-downloads.png"),
    });
  }
  await value("downloads", "resume", paused.id);
  await until(
    "active worker before exit confirmation",
    async () => (await jobs()).find((item) => item.id === paused.id),
    (job) => job.status === "downloading" && job.downloadedBytes > paused.downloadedBytes,
    60_000,
  );
  await app.evaluate(({ dialog }) => {
    globalThis.__smokeExitPrompts = 0;
    dialog.showMessageBox = async () => {
      globalThis.__smokeExitPrompts++;
      return { response: 0, checkboxChecked: false };
    };
  });
  await value("window", "exit");
  await until(
    "active exit Cancel prompt",
    () => app.evaluate(() => globalThis.__smokeExitPrompts),
    (count) => count === 1,
  );
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.ok(
    ["analyzing", "downloading", "processing"].includes(
      (await jobs()).find((item) => item.id === paused.id).status,
    ),
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await Promise.all([
    app.waitForEvent("close", { timeout: 30_000 }),
    page.evaluate(() => {
      void window.mediaVault.window.exit();
    }),
  ]);
  app = undefined;
  page = undefined;
  await launch("persistent-profile");
  assert.equal((await value("settings", "getDownloads")).concurrency, 1);
  assert.equal((await jobs()).find((job) => job.id === paused.id).status, "paused");
  await delay(700);
  assert.equal(
    (await jobs()).find((job) => job.id === paused.id).status,
    "paused",
    "restart must not automatically resume",
  );
  assert.ok((await value("library", "list")).some((item) => item.id === media.id));
  await value("downloads", "resume", paused.id);
  const resumed = await jobState(paused.id, "completed");
  assert.ok(resumed.attempts > paused.attempts);
  assert.ok(
    rangeRequests.some((request) => request.path === "/slow.mp4" && request.start > 0),
    "resume did not request retained partial bytes",
  );
  const cancelCandidate = await scanFixture("/slow-analysis");
  const cancelledJob = await addFixture(cancelCandidate, "Smoke retry");
  await until(
    "real progress before cancel",
    async () => (await jobs()).find((item) => item.id === cancelledJob.id),
    (job) => job.status === "downloading" && job.downloadedBytes >= 8192,
    60_000,
  );
  await value("downloads", "cancel", cancelledJob.id);
  await jobState(cancelledJob.id, "cancelled");
  await value("downloads", "retry", cancelledJob.id);
  await jobState(cancelledJob.id, "completed");
  const activities = await value("activity", "list");
  for (const type of [
    "downloadQueued",
    "downloadStarted",
    "downloadPaused",
    "downloadResumed",
    "downloadCancelled",
    "downloadCompleted",
  ])
    assert.ok(
      activities.some((entry) => entry.type === type),
      `Missing activity ${type}`,
    );
  console.log(
    "[desktop smoke] Background download while hidden to tray, native reopen, progress/pause, explicit-exit Cancel/Exit, relaunch/resume with HTTP Range, cancel/retry and persisted activity verified.",
  );

  // Native dialogs are stubbed only at the OS boundary; real files go through ffprobe.
  await page.getByRole("link", { name: label("nav.library"), exact: true }).click();
  await picker([fixturePath]);
  await page.getByRole("button", { name: label("library.addFile"), exact: true }).click();
  const imported = await until(
    "native file import",
    () => value("library", "list"),
    (items) => items.some((item) => item.localPath === fixturePath),
  );
  const local = imported.find((item) => item.localPath === fixturePath);
  assert.equal(local.sourceType, "local");
  assert.equal(local.videoCodec, "h264");
  await picker([fixturePath]);
  assert.deepEqual(await value("library", "addFile"), { added: 0, skipped: 1, failed: 0 });
  const playUrl = await value("library", "play", local.id);
  const playbackResponses = [];
  const recordPlayback = (response) => {
    if (response.url() === playUrl) playbackResponses.push(response);
  };
  page.on("response", recordPlayback);
  await page.evaluate(() => {
    document.addEventListener(
      "loadedmetadata",
      (event) => {
        if (event.target instanceof HTMLVideoElement)
          window.__smokeLoadedMetadata = {
            width: event.target.videoWidth,
            duration: event.target.duration,
          };
      },
      true,
    );
  });
  await page
    .getByRole("button", {
      name: label("library.showDetails").replace("{title}", local.title),
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: label("common.play"), exact: true })
    .click();
  await until(
    "real MP4 playback through protected protocol",
    () =>
      page.locator("video").evaluate((video) => ({
        ready: video.readyState,
        width: video.videoWidth,
        error: video.error?.code,
      })),
    (video) => video.ready >= 2 && video.width === 320,
    20_000,
  );
  const metadataEvent = await page.evaluate(() => window.__smokeLoadedMetadata);
  assert.equal(metadataEvent.width, 320);
  assert.ok(metadataEvent.duration > 2.9);
  const responses = await Promise.all(
    playbackResponses.map(async (response) => ({
      status: response.status(),
      range: (await response.request().allHeaders()).range,
    })),
  );
  assert.ok(
    responses.some((response) => response.status === 206 && /^bytes=/.test(response.range)),
    "video playback did not receive a partial-content response",
  );
  page.off("response", recordPlayback);
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    await page.screenshot({
      path: join(resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS), "desktop-player.png"),
    });
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await value("library", "remove", local.id);
  await access(fixturePath);
  assert.equal(
    (await value("library", "list")).some((item) => item.id === local.id),
    false,
  );
  const folder = join(scratch, "selected-import");
  await mkdir(join(folder, "nested"), { recursive: true });
  await copyFile(fixturePath, join(folder, "top.mp4"));
  await copyFile(fixturePath, join(folder, "nested", "child.mp4"));
  await picker([folder]);
  assert.deepEqual(await value("library", "addFolder", false), { added: 1, skipped: 0, failed: 0 });
  assert.deepEqual(await value("library", "addFolder", true), { added: 1, skipped: 1, failed: 0 });
  const top = (await value("library", "list")).find(
    (item) => item.localPath === join(folder, "top.mp4"),
  );
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  assert.equal(await value("library", "deleteFile", top.id), false);
  await access(top.localPath);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  assert.equal(await value("library", "deleteFile", top.id), true);
  await assert.rejects(access(top.localPath));
  assert.equal(
    (await value("library", "list")).some((item) => item.id === top.id),
    false,
  );
  await value("library", "refresh");
  await page.getByText("child", { exact: true }).waitFor();
  await until(
    "deleted import disappears from Library snapshot",
    () => page.getByText("top", { exact: true }).count(),
    (count) => count === 0,
  );
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    await page.screenshot({
      path: join(resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS), "desktop-library.png"),
    });
  }
  await value("downloads", "clearCompleted");
  assert.deepEqual(await jobs(), []);
  assert.ok(
    (await value("library", "list")).some((item) => item.id === media.id),
    "clear completed deleted Library media",
  );
  await access(completed.outputPath);
  console.log(
    "[desktop smoke] Native imports, deduplication, selected-folder recursion, secure playback, remove/delete and completed cleanup verified.",
  );
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
}

try {
  await generateFixture();
  if (process.argv.includes("--dev")) {
    const { createServer } = await import("vite");
    devServer = await createServer({
      configFile: join(root, "vite.desktop.config.ts"),
      root: join(root, "desktop"),
      logLevel: "error",
    });
    await devServer.listen();
  }
  await firstRunSmoke();
  await mkdir(cookieDirectory(), { recursive: true });
  const staleCookie = join(cookieDirectory(), `cookie-${randomUUID()}.txt`);
  await writeFile(
    staleCookie,
    `# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\t${authCookieName}\t${authCookieValue}\n`,
    { mode: 0o600 },
  );
  await launch("persistent-profile");
  await assert.rejects(
    access(staleCookie),
    (error) => error.code === "ENOENT",
    "startup retained a stale cookie file",
  );
  await assertCookieFilesRemoved();

  // Accidentally exposing Node or generic IPC must fail even in the app renderer.
  const surface = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    groups: Object.keys(window.mediaVault).sort(),
    genericIpc: Object.values(window.mediaVault).some((group) =>
      ["send", "invoke", "sendSync", "on", "ipcRenderer"].some((key) => key in group),
    ),
  }));
  assert.equal(surface.require, "undefined");
  assert.equal(surface.process, "undefined");
  assert.equal(surface.genericIpc, false);
  assert.deepEqual(surface.groups, [
    "activity",
    "binaries",
    "browser",
    "diagnostics",
    "downloads",
    "drive",
    "library",
    "maintenance",
    "product",
    "settings",
    "storage",
    "window",
  ]);
  assert.equal(
    (await value("settings", "getProduct")).firstLaunchCompleted,
    true,
    "existing installations must not see onboarding",
  );
  assert.equal(await value("product", "getVersion"), expectedVersion);
  assert.deepEqual(await bridge("settings", "updateProduct", { firstLaunchCompleted: true }), {
    ok: false,
    error: "invalidInput",
  });
  await verifyDisconnectedDrive();
  await storageSmoke();
  await value("settings", "update", { homepage: `${origin}/home`, saveSession: true });

  // Real links and toolbar controls must move the native view and its address state.
  assert.equal((await navigate("/first")).title, "MediaVault first");
  await remote("document.getElementById('next').click()");
  await loaded("/second");
  await until(
    "address bar follows native link navigation",
    () => page.getByRole("textbox", { name: label("desktop.address"), exact: true }).inputValue(),
    (url) => url === `${origin}/second`,
  );
  assert.equal((await state()).canGoBack, true);
  await page.getByRole("button", { name: label("browser.back"), exact: true }).click();
  await loaded("/first");
  assert.equal((await state()).canGoForward, true);
  await page.getByRole("button", { name: label("browser.forward"), exact: true }).click();
  await loaded("/second");
  const loads = requests.get("/second");
  await page.getByRole("button", { name: label("browser.refresh"), exact: true }).click();
  await until(
    "reload makes another HTTP request",
    () => requests.get("/second"),
    (count) => count > loads,
  );
  await loaded("/second");
  await page.getByRole("button", { name: label("browser.home"), exact: true }).click();
  await loaded("/home");

  // A remote website must have neither Node, the app bridge, nor renderer session cookies.
  assert.deepEqual(
    await remote(`({ require: typeof window.require, process: typeof window.process,
    mediaVault: typeof window.mediaVault, ipcRenderer: typeof window.ipcRenderer })`),
    {
      require: "undefined",
      process: "undefined",
      mediaVault: "undefined",
      ipcRenderer: "undefined",
    },
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow, webContents }, origin) => {
      const browser = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(origin));
      return browser.session !== BrowserWindow.getAllWindows()[0].webContents.session;
    }, origin),
    true,
  );

  // Even possession of the preload API must not authorize another WebContents.
  const protectedSettings = await value("settings", "get");
  const foreignResult = await app.evaluate(
    async ({ BrowserWindow }, { origin, preload }) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      try {
        await foreign.loadURL(`${origin}/foreign`);
        return await foreign.webContents.executeJavaScript(
          `Promise.all([window.mediaVault.settings.update(${JSON.stringify({ homepage: `${origin}/foreign-change`, saveSession: false })}), window.mediaVault.drive.getState(), window.mediaVault.settings.getDrive(), window.mediaVault.settings.getProduct(), window.mediaVault.product.getVersion(), window.mediaVault.storage.get(), window.mediaVault.maintenance.get(), window.mediaVault.diagnostics.get()])`,
        );
      } finally {
        foreign.destroy();
      }
    },
    { origin, preload: join(applicationPath, "dist-electron", "preload.cjs") },
  );
  assert.deepEqual(
    foreignResult,
    Array.from({ length: 8 }, () => ({ ok: false, error: "unavailable" })),
    "a foreign IPC sender was authorized",
  );
  assert.deepEqual(await value("settings", "get"), protectedSettings);
  await remote("window.open('/second', '_blank'); true");
  await loaded("/second");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

  // Malformed IPC values must be rejected without changing native navigation or bounds.
  for (const url of [
    "javascript:alert(1)",
    "file:///private",
    "data:text/html,unsafe",
    "https://user:password@example.com",
    { url: `${origin}/home` },
  ]) {
    assert.deepEqual(await bridge("browser", "open", url), { ok: false, error: "invalidUrl" });
  }
  assert.equal((await state()).url, `${origin}/second`);
  const beforeInvalidBounds = (await assertBounds()).native.bounds;
  for (const bounds of [
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: -1, height: 10 },
    { x: 0, y: 0, width: Number.NaN, height: 10 },
    { x: 0, y: 0, width: 999999, height: 10 },
  ])
    assert.deepEqual(await bridge("browser", "setBounds", bounds), {
      ok: false,
      error: "invalidInput",
    });
  assert.deepEqual((await geometry()).bounds, beforeInvalidBounds);

  // Duplicate byte/range requests must not produce duplicate candidates; signed URLs stay distinct.
  await navigate("/media");
  await remote("window.fixtureReady");
  await remote(
    "fetch('/clip.mp4?signature=first').then(response => response.arrayBuffer()).then(() => true)",
  );
  const detected = await until(
    "direct media and HLS candidates",
    state,
    (item) => item.media.length >= 3,
  );
  assert.equal(
    detected.media.filter((item) => item.url === `${origin}/clip.mp4?signature=first`).length,
    1,
  );
  assert.equal(
    detected.media.filter((item) => item.url === `${origin}/clip.mp4?signature=second`).length,
    1,
  );
  assert.equal(detected.media.find((item) => item.url === `${origin}/master.m3u8`)?.type, "hls");
  assert.equal(
    detected.media.some((item) => /segment-01\.ts|tiny\.m4s/.test(item.url)),
    false,
  );
  assert.ok(
    detected.media.every(
      (item) => item.origin === "network" && item.sourcePageUrl === `${origin}/media`,
    ),
  );
  await navigate("/home");
  assert.equal((await state()).media.length, 0, "navigation must clear stale media candidates");

  // Sidebar and native window resizing must keep the browser inside its measured slot.
  const expanded = (await assertBounds()).native.bounds;
  await page.getByRole("button", { name: label("nav.collapse"), exact: true }).click();
  await until(
    "sidebar collapse changes native bounds",
    geometry,
    (item) => item.bounds.x < expanded.x - 50,
  );
  await assertBounds();
  await page.getByRole("button", { name: label("desktop.expandSidebar"), exact: true }).click();
  await until(
    "sidebar expansion restores native bounds",
    geometry,
    (item) => Math.abs(item.bounds.x - expanded.x) <= 2,
  );
  await page.getByRole("button", { name: label("desktop.hidePanel"), exact: true }).click();
  await until(
    "hiding detected media widens the native browser",
    geometry,
    (item) => item.bounds.width > expanded.width + 150,
  );
  await assertBounds();
  await page.getByRole("button", { name: label("desktop.showPanel"), exact: true }).click();
  await until(
    "showing detected media restores native browser width",
    geometry,
    (item) => Math.abs(item.bounds.width - expanded.width) <= 2,
  );
  await assertBounds();
  const originalSize = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getContentSize();
    window.setContentSize(size[0] + 80, size[1] + 40);
    return size;
  });
  await until(
    "window resize changes native bounds",
    geometry,
    (item) => item.bounds.width !== expanded.width || item.bounds.height !== expanded.height,
  );
  await assertBounds();
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size),
    originalSize,
  );
  await assertBounds();

  await page.getByRole("link", { name: label("nav.settings"), exact: true }).click();
  await until(
    "leaving Browser hides the native view",
    geometry,
    (item) =>
      !item.attached || !item.visible || item.bounds.width === 0 || item.bounds.height === 0,
  );
  await page.getByRole("link", { name: label("nav.browser"), exact: true }).click();
  await assertBounds();
  await page.getByRole("button", { name: "vi", exact: true }).click();
  await page.getByRole("button", { name: label("browser.scan", "vi"), exact: true }).waitFor();
  await page
    .getByRole("button", { name: label("desktop.window.minimize", "vi"), exact: true })
    .waitFor();
  await page.getByRole("button", { name: "en", exact: true }).click();
  await page.getByRole("button", { name: label("browser.scan"), exact: true }).waitFor();

  // The title bar must control the actual native window, including restore after maximize.
  await page.getByRole("button", { name: label("desktop.window.maximize"), exact: true }).click();
  await until(
    "titlebar maximize",
    () => value("window", "getState"),
    (item) => item.maximized,
  );
  await assertBounds();
  await page.getByRole("button", { name: label("desktop.window.restore"), exact: true }).click();
  await until(
    "titlebar restore",
    () => value("window", "getState"),
    (item) => !item.maximized,
  );
  await page.getByRole("button", { name: label("desktop.window.minimize"), exact: true }).click();
  await until("titlebar minimize", () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.restore();
    window.focus();
  });
  await assertBounds();

  // Run the real bundled/configured yt-dlp when present; never fabricate analysis results.
  await navigate("/analysis");
  const binary = await value("binaries", "status");
  await page.getByRole("button", { name: label("browser.scan"), exact: true }).click();
  const analyzed = await until(
    "metadata scan settles",
    state,
    (item) => !item.scanning && (item.analysis !== null || item.error !== null),
    50_000,
  );
  if (binary.available) {
    assert.equal(analyzed.error, null);
    assert.match(analyzed.analysis.title, /MediaVault analysis fixture/);
    assert.ok(
      analyzed.analysis.formats.some(
        (item) => item.url === `${origin}/clip.mp4` && item.origin === "analysis",
      ),
    );
    assert.ok(analyzed.media.some((item) => item.origin === "analysis"));
    analysisResult = `real yt-dlp formats (${binary.version ?? "version unavailable"})`;
  } else {
    assert.ok(["binaryMissing", "binaryInvalid"].includes(analyzed.error));
    assert.equal(analyzed.analysis, null);
  }
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    const destination = resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS);
    await mkdir(destination, { recursive: true });
    if (analyzed.analysis)
      await page.getByText(analyzed.analysis.title, { exact: true }).first().waitFor();
    await page.screenshot({ path: join(destination, "desktop-smoke.png") });
    const nativeImage = await app.evaluate(async ({ webContents }, origin) => {
      const browser = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(origin));
      return (await browser.capturePage()).toDataURL();
    }, origin);
    await writeFile(
      join(destination, "desktop-browser.png"),
      Buffer.from(nativeImage.split(",")[1], "base64"),
    );
  }

  await phaseTwoSmoke();
  await authenticatedDownloadSmoke();
  await diagnosticsSmoke();

  // A cookie survives a full process relaunch, without being shared with the shell session.
  await navigate("/home");
  await remote(
    "document.cookie = 'mv_smoke_persist=present; Max-Age=3600; Path=/; SameSite=Lax'; true",
  );
  assert.equal(
    await remote("document.cookie.split('; ').includes('mv_smoke_persist=present')"),
    true,
  );
  assert.equal(
    await app.evaluate(
      async ({ BrowserWindow }, origin) =>
        (await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({ url: origin }))
          .length,
      origin,
    ),
    0,
  );
  await close();
  await launch("persistent-profile");
  await value("browser", "home");
  await loaded("/home");
  assert.deepEqual(await value("settings", "getDrive"), persistedDriveSettings);
  publicDriveSnapshot(await value("drive", "getState"));
  assert.equal((await value("settings", "get")).homepage, `${origin}/home`);
  assert.equal(
    await remote("document.cookie.split('; ').includes('mv_smoke_persist=present')"),
    true,
    "persistent browser cookie was lost after relaunch",
  );
  await remote("localStorage.setItem('mv_smoke_storage', 'present'); true");
  await value("settings", "clearCookies");
  assert.equal(
    await remote("document.cookie.includes('mv_smoke_persist=')"),
    false,
    "clearCookies must clear the active browser session",
  );
  assert.equal(
    await remote("localStorage.getItem('mv_smoke_storage')"),
    "present",
    "clearing cookies must preserve unrelated persistent browser storage",
  );
  await clearBrowserData();
  assert.equal(
    await remote("localStorage.getItem('mv_smoke_storage')"),
    null,
    "Clear browser data must remove localStorage",
  );

  // Disabling persistence creates a separate ephemeral session and survives in settings.
  await remote(
    "document.cookie = 'mv_smoke_saved=present; Max-Age=3600; Path=/'; localStorage.setItem('mv_smoke_saved', 'present'); true",
  );
  await saveSession(false);
  assert.equal(
    await remote("document.cookie.includes('mv_smoke_saved=')"),
    false,
    "the ephemeral session must not inherit persisted cookies",
  );
  assert.equal(await remote("localStorage.getItem('mv_smoke_saved')"), null);
  await remote(
    "document.cookie = 'mv_smoke_ephemeral=present; Max-Age=3600; Path=/'; localStorage.setItem('mv_smoke_ephemeral', 'present'); true",
  );
  assert.equal(await remote("document.cookie.includes('mv_smoke_ephemeral=')"), true);
  await close();
  await launch("persistent-profile");
  await value("browser", "home");
  await loaded("/home");
  assert.equal((await value("settings", "get")).saveSession, false);
  assert.equal(
    await remote("document.cookie.includes('mv_smoke_ephemeral=')"),
    false,
    "saveSession=false must not retain cookies across a process restart",
  );
  assert.equal(await remote("localStorage.getItem('mv_smoke_ephemeral')"), null);
  assert.equal(await remote("document.cookie.includes('mv_smoke_saved=')"), false);

  // Clear browser data must also clear the inactive saved profile while persistence is off.
  await clearBrowserData();
  await saveSession(true);
  assert.equal(
    await remote("document.cookie.includes('mv_smoke_saved=')"),
    false,
    "Clear browser data left cookies in the inactive saved profile",
  );
  assert.equal(
    await remote("localStorage.getItem('mv_smoke_saved')"),
    null,
    "Clear browser data left localStorage in the inactive saved profile",
  );
  await close();

  // Packaged binaries are immutable resources; development-only overrides are intentionally unavailable.
  if (!packagedExecutable) {
    await verifyAnalysisError(
      join(scratch, "missing-yt-dlp.exe"),
      "binaryMissing",
      "missing-profile",
    );
    const invalidBinary = join(
      scratch,
      process.platform === "win32" ? "invalid-yt-dlp.exe" : "invalid-yt-dlp",
    );
    await writeFile(invalidBinary, "");
    await chmod(invalidBinary, 0o755);
    await verifyAnalysisError(invalidBinary, "binaryInvalid", "invalid-profile");
  }
  assert.deepEqual(rendererErrors, [], "the application renderer emitted uncaught errors");
  console.log(
    `[desktop smoke] PASS${packagedExecutable ? " (packaged)" : ""}: onboarding/persistence, tray/background/explicit exit, product metadata, disconnected Drive/settings/privacy, real download/remux/probe, progress/pause/resume/cancel/retry, SQLite/Library persistence, import/play/remove/delete, navigation/detection/bounds, EN/VI/window controls, IPC/session isolation, cookie persistence, authenticated analysis/download/session-loss recovery and secret cleanup, storage clearing, real diagnostics/log privacy/export and unconfigured update controls${packagedExecutable ? ", bundled binaries" : ", binary errors"}; ${analysisResult}.`,
  );
} catch (error) {
  if (page) {
    console.error(
      "[desktop smoke] Download snapshot:",
      await bridge("downloads", "list")
        .then((result) =>
          result.ok
            ? result.value.map((job) => ({
                status: [
                  "queued",
                  "analyzing",
                  "downloading",
                  "processing",
                  "paused",
                  "completed",
                  "failed",
                  "cancelled",
                ].includes(job.status)
                  ? job.status
                  : "unknown",
                progress: Number.isFinite(job.progress) ? job.progress : null,
              }))
            : "unavailable",
        )
        .catch(() => "unavailable"),
    );
  }
  if (page && process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    const destination = resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS);
    await mkdir(destination, { recursive: true });
    await page.screenshot({ path: join(destination, "desktop-smoke-failure.png") }).catch(() => {});
    console.error(
      `[desktop smoke] Failure screenshot: ${join(destination, "desktop-smoke-failure.png")}`,
    );
  }
  console.error(`[desktop smoke] FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await close().catch(() => {});
  if (process.env.MEDIAVAULT_SMOKE_ARTIFACTS) {
    await copyFile(
      join(scratch, "persistent-profile", "logs", "mediavault.log"),
      join(resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS), "desktop-main.log"),
    ).catch(() => {});
  }
  await devServer?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  // Delete only this invocation's generated temporary directory.
  const tempRelative = relative(resolve(tmpdir()), resolve(scratch));
  assert.ok(
    !isAbsolute(tempRelative) &&
      !tempRelative.startsWith(`..${sep}`) &&
      tempRelative !== ".." &&
      tempRelative.startsWith("mediavault-smoke-"),
  );
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
