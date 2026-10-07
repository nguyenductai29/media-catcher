// Explicit, interactive real-account verification. Normal smoke/CI never imports this file.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { generateFixtures, parseGeneratorArguments } from "./generate-fixtures.mjs";
import { startFixtureServer } from "./fixture-server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--help")) {
  console.log(`MediaVault real Google Drive check (interactive only)

Set GOOGLE_CLIENT_ID for your OAuth Desktop client, optionally GOOGLE_CLIENT_SECRET.
Read docs/google-drive-setup.md, then run npm run test:drive:manual.
To load a local env file: node --env-file=.env.local scripts/test-drive-manual.mjs
Build first with npm run build:desktop; install tools with npm run setup:ffmpeg.
For an installed/built app, add --packaged-executable ABSOLUTE_EXE_PATH.
That option uses its bundled FFmpeg tools and isolated --user-data-dir arguments.

Optional larger playable fixture: npm run test:drive:manual -- --large-mib 128
The size accepts 16..2048 MiB; generation uses real video, never sparse padding.
The helper generates 10s/60s MP4 and HLS, serves only on localhost, and opens an isolated
profile. It never initiates login, chooses user media, uploads, or deletes for you.
Use the actual app UI. Terminal commands: status, restart, help, quit.
The generated files/profile remain in the printed temporary directory for inspection.
Disconnect before removing that directory. Uploaded fixtures remain on Google Drive
until you remove them yourself. No credential values are printed.`);
  process.exit(0);
}
const arguments_ = process.argv.slice(2);
const fixtureArguments = [];
const seenArguments = new Set();
let packagedExecutable;
for (let index = 0; index < arguments_.length; index++) {
  const key = arguments_[index];
  const value = arguments_[++index];
  if (seenArguments.has(key) || !value || value.startsWith("--"))
    throw new Error("Invalid manual helper arguments; use --help.");
  seenArguments.add(key);
  if (key === "--large-mib") fixtureArguments.push(key, value);
  else if (
    key === "--packaged-executable" &&
    isAbsolute(value) &&
    extname(value).toLowerCase() === ".exe" &&
    !/[\p{Cc}]/u.test(value)
  )
    packagedExecutable = value;
  else
    throw new Error(
      "Manual helper accepts --large-mib 16..2048 and --packaged-executable ABSOLUTE_EXE_PATH.",
    );
}
const { largeMiB } = parseGeneratorArguments(fixtureArguments);

if (!process.stdin.isTTY) throw new Error("Run this manual helper in an interactive terminal.");
if (!process.env.GOOGLE_CLIENT_ID?.trim())
  throw new Error(
    "Set GOOGLE_CLIENT_ID first; see docs/google-drive-setup.md. No login was started.",
  );
for (const path of packagedExecutable
  ? [packagedExecutable, join(dirname(packagedExecutable), "resources", "app.asar")]
  : ["dist-electron/main.cjs", "dist-electron/preload.cjs", "dist-desktop/index.html"])
  await access(isAbsolute(path) ? path : join(root, path)).catch(() => {
    throw new Error(
      "Build the desktop app first or select a valid packaged MediaVault executable.",
    );
  });

const scratch = await mkdtemp(join(tmpdir(), "mediavault-drive-manual-"));
const profile = join(scratch, "profile");
await mkdir(profile);
const generated = await generateFixtures({
  outputDirectory: join(scratch, "generated"),
  largeMiB,
  ...(packagedExecutable
    ? {
        ffmpegPath: join(dirname(packagedExecutable), "resources", "bin", "ffmpeg.exe"),
        ffprobePath: join(dirname(packagedExecutable), "resources", "bin", "ffprobe.exe"),
      }
    : {}),
});
const fixture = join(generated.directory, "clip-10s.mp4");
const largerFixture = largeMiB ? join(generated.directory, "large.mp4") : null;
const server = await startFixtureServer({ directory: generated.directory });
const origin = server.origin;
await writeFile(
  join(profile, "browser-settings.json"),
  JSON.stringify({ version: 1, homepage: `${origin}/video-10s`, saveSession: true }),
).catch(async () => {
  await server.close();
  throw new Error("Could not initialize the isolated manual profile.");
});

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
  for (const name of ["MEDIAVAULT_YTDLP_PATH", "MEDIAVAULT_FFMPEG_PATH", "MEDIAVAULT_FFPROBE_PATH"])
    delete env[name];
  if (packagedExecutable) {
    delete env.MEDIAVAULT_USER_DATA;
    delete env.MEDIAVAULT_VIDEOS_DIR;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
  }
  app = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable
      ? [`--user-data-dir=${profile}`, `--media-videos-dir=${join(scratch, "videos")}`]
      : ["."],
    cwd: packagedExecutable ? dirname(packagedExecutable) : root,
    env,
    timeout: 30_000,
  });
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
  const profileMatches = await app.evaluate(
    ({ app }, expected) => {
      const path = process.getBuiltinModule("path");
      const actual = path.resolve(app.getPath("userData"));
      const requested = path.resolve(expected.directory);
      return (
        (!expected.packaged || app.isPackaged) &&
        (process.platform === "win32"
          ? actual.toLowerCase() === requested.toLowerCase()
          : actual === requested)
      );
    },
    { directory: profile, packaged: Boolean(packagedExecutable) },
  );
  assert.equal(profileMatches, true, "Application did not use the isolated manual profile");
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
      void window.mediaVault.window.exit();
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
60-second fixture: ${join(generated.directory, "clip-60s.mp4")}
Larger fixture: ${largerFixture ?? "not generated; rerun with --large-mib 128 for a fresh isolated profile"}
Local download page: ${origin}/video-10s
Isolated profile: ${profile}

1. In Google Drive, select Connect and authorize in your system browser.
2. In Library, Add file and choose only the generated fixture above.
3. Keep Settings > Delete behavior = Never. Upload from Library. Check real progress,
   verified completion, Local + Drive, Open in Drive, and that the local file remains.
4. Upload the larger generated fixture for pause/resume/cancel/retry. Small files may finish
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
  await server.close();
  console.log(`Generated data retained for inspection: ${scratch}`);
  console.log(
    "Disconnect the test account before removing the profile. Cloud test files require manual cleanup.",
  );
}
