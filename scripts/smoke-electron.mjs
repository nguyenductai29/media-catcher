// Run after npm run build:desktop. Requires a graphical desktop session.
// All web traffic and browser profiles used by these checks are local fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

for (const artifact of [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-desktop/index.html",
]) {
  await access(join(root, artifact)).catch(() => {
    throw new Error(`Missing ${artifact}; build the desktop app before running this smoke test.`);
  });
}

const scratch = await mkdtemp(join(tmpdir(), "mediavault-smoke-"));
const requests = new Map();
const mediaBytes = Buffer.alloc(32 * 1024);
// Metadata-only analysis uses the HTML source URL; this is not a playable clip.
mediaBytes.set(Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
const manifest =
  "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\n/segment-01.ts\n#EXT-X-ENDLIST\n";
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
  const send = (type, body, extra = {}) => {
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  if (url.pathname === "/clip.mp4")
    return send("video/mp4", mediaBytes, { "Content-Length": mediaBytes.length });
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
  const video =
    url.pathname === "/analysis"
      ? '<video controls preload="none"><source src="/clip.mp4" type="video/mp4"></video>'
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

async function launch(profile, binaryPath) {
  const profilePath = join(scratch, profile);
  await mkdir(profilePath, { recursive: true });
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
  const env = { ...process.env, MEDIAVAULT_USER_DATA: profilePath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MEDIAVAULT_DEV_URL;
  if (devServer) env.MEDIAVAULT_DEV_URL = "http://127.0.0.1:5174";
  if (binaryPath !== undefined) env.MEDIAVAULT_YTDLP_PATH = binaryPath;
  app = await electron.launch({ args: ["."], cwd: root, env, timeout: 30_000 });
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
  await page.getByRole("button", { name: "en", exact: true }).click();
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
  await page
    .getByRole("textbox", { name: label("desktop.address"), exact: true })
    .fill(`${origin}${path}`);
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
async function close() {
  if (!app) return;
  const closing = app;
  app = undefined;
  page = undefined;
  await closing.close();
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

try {
  if (process.argv.includes("--dev")) {
    const { createServer } = await import("vite");
    devServer = await createServer({
      configFile: join(root, "vite.desktop.config.ts"),
      root: join(root, "desktop"),
      logLevel: "error",
    });
    await devServer.listen();
  }
  await launch("persistent-profile");

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
  assert.deepEqual(surface.groups, ["binaries", "browser", "settings", "window"]);
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
          `window.mediaVault.settings.update(${JSON.stringify({ homepage: `${origin}/foreign-change`, saveSession: false })})`,
        );
      } finally {
        foreign.destroy();
      }
    },
    { origin, preload: join(root, "dist-electron", "preload.cjs") },
  );
  assert.deepEqual(
    foreignResult,
    { ok: false, error: "unavailable" },
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

  // Missing and invalid executables must produce localized error codes without raw process output.
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
  assert.deepEqual(rendererErrors, [], "the application renderer emitted uncaught errors");
  console.log(
    `[desktop smoke] PASS: navigation, detection, bounds/panel, routes, EN/VI, window controls, IPC/session isolation, cookie persistence, storage clearing, binary errors; ${analysisResult}.`,
  );
} catch (error) {
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
