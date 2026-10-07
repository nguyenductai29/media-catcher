// Explicit, interactive real-account verification. Normal smoke/CI never imports this file.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--help")) {
  console.log(`MediaVault real Google Drive check (interactive only)

Set GOOGLE_CLIENT_ID for your OAuth Desktop client, optionally GOOGLE_CLIENT_SECRET.
Read docs/google-drive-setup.md, then run npm run test:drive:manual.
To load a local env file: node --env-file=.env.local scripts/test-drive-manual.mjs
Build first with npm run build:desktop; install tools with npm run setup:ffmpeg.

The helper generates one tiny MP4, serves it only on localhost, and opens an isolated
profile. It never initiates login, chooses user media, uploads, or deletes for you.
Use the actual app UI. Terminal commands: status, restart, help, quit.
The generated files/profile remain in the printed temporary directory for inspection.
Disconnect before removing that directory. Uploaded fixtures remain on Google Drive
until you remove them yourself. No credential values are printed.`);
  process.exit(0);
}

if (!process.stdin.isTTY) throw new Error("Run this manual helper in an interactive terminal.");
if (!process.env.GOOGLE_CLIENT_ID?.trim())
  throw new Error(
    "Set GOOGLE_CLIENT_ID first; see docs/google-drive-setup.md. No login was started.",
  );
for (const path of [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-desktop/index.html",
])
  await access(join(root, path)).catch(() => {
    throw new Error("Build the desktop app first: npm run build:desktop");
  });

const scratch = await mkdtemp(join(tmpdir(), "mediavault-drive-manual-"));
const profile = join(scratch, "profile");
const filename = `MediaVault-drive-fixture-${Date.now()}.mp4`;
const fixture = join(scratch, filename);
await mkdir(profile);
await promisify(execFile)(
  join(root, "resources", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
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
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    "-shortest",
    fixture,
  ],
  { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
).catch(() => {
  throw new Error("Fixture generation failed. Install FFmpeg: npm run setup:ffmpeg");
});
const size = (await stat(fixture)).size;
const server = createServer((request, response) => {
  if (request.url === "/fixture.mp4") {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      response.writeHead(416);
      response.end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(fixture, { start, end });
    response.on("close", () => stream.destroy());
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  } else if (request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>${filename}</title><h1>MediaVault generated Drive fixture</h1><p>Three seconds of generated test video and audio. No user media.</p><video controls preload="none"><source src="/fixture.mp4" type="video/mp4"></video>`,
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(
  join(profile, "browser-settings.json"),
  JSON.stringify({ version: 1, homepage: origin, saveSession: true }),
);

let app;
let page;
let closed = true;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function launch() {
  const env = {
    ...process.env,
    MEDIAVAULT_USER_DATA: profile,
    MEDIAVAULT_VIDEOS_DIR: join(scratch, "videos"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MEDIAVAULT_DEV_URL;
  app = await electron.launch({ args: ["."], cwd: root, env, timeout: 30_000 });
  closed = false;
  app.on("close", () => {
    closed = true;
  });
  const deadline = Date.now() + 30_000;
  while (!page || !page.url().startsWith("mediavault://app/")) {
    page = app.windows().find((candidate) => candidate.url().startsWith("mediavault://app/"));
    if (Date.now() >= deadline) throw new Error("Application renderer did not start.");
    if (!page) await delay(100);
  }
  await page.waitForFunction(() => Boolean(window.mediaVault?.drive));
  console.log(
    "Isolated MediaVault opened. Use the app UI for Connect and all upload/delete actions.",
  );
}
async function status() {
  if (closed) {
    console.log("Application closed. Type restart to reopen this profile.");
    return;
  }
  const result = await page.evaluate(() => window.mediaVault.drive.getState());
  assert.equal(result.ok, true, "Drive snapshot unavailable");
  const state = result.value;
  const privateFields = new Set([
    "accessToken",
    "refreshToken",
    "sessionUrl",
    "sessionEncrypted",
    "plannedFileId",
    "clientSecret",
    "credentials",
    "localPath",
    "modifiedAt",
    "attempts",
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(privateFields.has(key), false, "A private field reached the renderer");
      if (typeof child === "string")
        assert.doesNotMatch(
          child,
          /ya29\.|Bearer\s|upload_id=|access_token|refresh_token|client_secret/i,
          "A secret reached the renderer",
        );
      visit(child);
    }
  };
  visit(state);
  console.log(
    `Account: ${state.account.connected ? "connected" : "disconnected"}; configured: ${state.account.configured}; delete policy: ${state.settings.deleteLocal}; uploads: ${state.uploads.length}.`,
  );
  for (const [index, upload] of state.uploads.entries())
    console.log(
      `Upload ${index + 1}: ${upload.status}, ${upload.uploadedBytes}/${upload.fileSize} bytes, ${upload.progress.toFixed(1)}%.`,
    );
  console.log("Public snapshot privacy check passed. This is not a real-upload success assertion.");
}
async function requestClose() {
  if (closed) return true;
  console.log("Confirm Exit in MediaVault if prompted; Cancel leaves this helper running.");
  const ended = app.waitForEvent("close", { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  await page
    .evaluate(() => {
      void window.mediaVault.window.close();
    })
    .catch(() => {});
  const didClose = await ended;
  if (!didClose)
    console.log("The app is still open. Pause work or answer its dialog, then try again.");
  return didClose;
}
function instructions() {
  console.log(`
Generated fixture: ${fixture}
Local download page: ${origin}/
Isolated profile: ${profile}

1. In Google Drive, select Connect and authorize in your system browser.
2. In Library, Add file and choose only the generated fixture above.
3. Keep Settings > Delete behavior = Never. Upload from Library. Check real progress,
   verified completion, Local + Drive, Open in Drive, and that the local file remains.
4. For pause/resume/cancel/retry, act while an upload is active. Tiny files may finish
   before Pause; do not report a skipped race as tested. Type restart while paused,
   confirm the account survives and work remains paused, then Resume in the UI.
5. For auto-upload, enable it and download the local page above through Browser.
   Confirm exactly one upload after download completion. Repeat with Ask me (first
   cancel deletion), then with Automatically using a fresh generated download copy.
   Confirm only verified completion deletes that copy and its Drive-only row remains.
6. Check Activity, switch EN/VI, Sync, and Disconnect. Local files and Drive copies
   must remain after disconnect. Remove uploaded test copies manually in Google Drive.

Commands: status (safe public summary), restart (same isolated profile), help, quit.
Authorization and cloud mutations always require your explicit actions in the app.
`);
}

const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  instructions();
  await launch();
  terminal.setPrompt("drive-manual> ");
  terminal.prompt();
  for await (const line of terminal) {
    const command = line.trim().toLowerCase();
    if (command === "status") await status();
    else if (command === "restart") {
      if (await requestClose()) {
        page = undefined;
        await launch();
        await status();
      }
    } else if (command === "quit" || command === "exit") {
      if (await requestClose()) break;
    } else if (command === "help" || command === "") instructions();
    else console.log("Commands: status, restart, help, quit.");
    terminal.prompt();
  }
} catch {
  // Deliberately do not print raw OAuth/network errors or arbitrary renderer payloads.
  console.error(
    "Manual helper stopped. Inspect the app's localized error and credential-safe technical log.",
  );
  process.exitCode = 1;
} finally {
  terminal.close();
  if (!closed) await requestClose().catch(() => {});
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  console.log(`Generated data retained for inspection: ${scratch}`);
  console.log(
    "Disconnect the test account before removing the profile. Cloud test files require manual cleanup.",
  );
}
