// Explicit Windows installer acceptance. Run only after both requested packages are built.
// NSIS /D and _?= must be unquoted and last: https://nsis.sourceforge.io/Docs/Chapter3.html
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/test-installer.mjs --baseline=<absolute 0.1.0 installer.exe> --upgrade=<absolute 0.1.1 installer.exe>\nRequires Windows x64 and no existing MediaVault installation. Installs only in a generated temporary Unicode directory, tests upgrade persistence and startup ON/OFF when no previous startup entry exists, then uninstalls. Existing application profiles and user media are never selected. Failures retain generated files for inspection. Evidence: artifacts/milestone-c/installer-result.json; set MEDIAVAULT_SMOKE_ARTIFACTS to choose another evidence directory.",
  );
  process.exit(0);
}
const artifact = join(
  resolve(process.env.MEDIAVAULT_SMOKE_ARTIFACTS ?? join(root, "artifacts", "milestone-c")),
  "installer-result.json",
);
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const taskkill = join(systemRoot, "System32", "taskkill.exe");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const inside = (parent, child) => {
  const path = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase());
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
};
const steps = [];
let stage = "preflight",
  scratch,
  installRoot,
  profile,
  videos,
  installedExecutable;
let application,
  page,
  installed = false,
  startupTouched = false,
  startupAllowed = false;
let passed = false,
  failure,
  installedVersions = [],
  cleanupVerified = false;
let startupBefore;
const cleanupErrors = [];

function installerArgument(name) {
  const prefix = `--${name}=`;
  const matching = args.filter((arg) => arg.startsWith(prefix));
  if (matching.length !== 1 || !isAbsolute(matching[0].slice(prefix.length)))
    throw new Error(`Expected exactly one --${name}=<absolute installer path>.`);
  const path = resolve(matching[0].slice(prefix.length));
  if (/\p{Cc}|"/u.test(path) || !path.toLowerCase().endsWith(".exe"))
    throw new Error(
      "Installer path must be an absolute executable path without control characters or quotes.",
    );
  return path;
}
async function terminateTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  await new Promise((resolveTermination) => {
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      killer.kill();
      resolveTermination();
    }, 10_000);
    killer.once("error", () => {
      clearTimeout(timer);
      resolveTermination();
    });
    killer.once("close", () => {
      clearTimeout(timer);
      resolveTermination();
    });
  });
}
async function run(
  file,
  arguments_,
  { label, timeout = 180_000, nsis = false, env = process.env } = {},
) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, arguments_, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...(nsis ? { windowsVerbatimArguments: true, argv0: `"${file}"` } : {}),
    });
    const output = [];
    let bytes = 0,
      settled = false;
    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateTree(child.pid);
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      void fail(`${label} exceeded its bounded wait.`);
    }, timeout);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) void fail(`${label} exceeded its output limit.`);
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) void fail(`${label} exceeded its output limit.`);
    });
    child.once("error", () => {
      void fail(`${label} could not start.`);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${label} exited with code ${code ?? "unknown"}.`));
      else resolveRun(Buffer.concat(output).toString("utf8"));
    });
  });
}
async function until(label, read, accept, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function registry() {
  // Read only. Never execute registry strings or remove registry entries ourselves.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$installations = @()
$startup = @()
$shortcuts = @()
foreach ($folder in @([Environment+SpecialFolder]::DesktopDirectory, [Environment+SpecialFolder]::CommonDesktopDirectory, [Environment+SpecialFolder]::Programs, [Environment+SpecialFolder]::CommonPrograms)) {
  $knownPath = [Environment]::GetFolderPath($folder)
  if (-not $knownPath) { throw 'Known shortcut folder could not be resolved.' }
  if (Test-Path -LiteralPath ([IO.Path]::Combine($knownPath, 'MediaVault.lnk'))) { $shortcuts += $folder.ToString() }
}
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
      if ($uninstall) {
        try {
          foreach ($name in $uninstall.GetSubKeyNames()) {
            $entry = $uninstall.OpenSubKey($name)
            if (-not $entry) { continue }
            try {
              $display = [string]$entry.GetValue('DisplayName')
              $command = [string]$entry.GetValue('UninstallString')
              if ($display -match '^MediaVault(?:\s|$)' -or $name -match 'MediaVault' -or $command -match 'Uninstall MediaVault\.exe') {
                $installations += [pscustomobject]@{ hive=$hive.ToString(); view=$view.ToString(); key=$name; version=[string]$entry.GetValue('DisplayVersion'); location=[string]$entry.GetValue('InstallLocation'); uninstall=$command }
              }
            } finally { $entry.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      }
      $run = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
      if ($run) {
        try {
          foreach ($name in $run.GetValueNames()) {
            if ($name -match 'MediaVault' -or [string]$run.GetValue($name) -match 'MediaVault\.exe') {
              $raw = [string]$run.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
              $hasher = [Security.Cryptography.SHA256]::Create()
              try { $fingerprint = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))) }
              finally { $hasher.Dispose() }
              $startup += [pscustomobject]@{ hive=$hive.ToString(); view=$view.ToString(); name=$name; kind=$run.GetValueKind($name).ToString(); fingerprint=$fingerprint }
            }
          }
        } finally { $run.Dispose() }
      }
    } finally { $base.Dispose() }
  }
}
$activeProcesses = @(Get-Process -Name MediaVault -ErrorAction SilentlyContinue).Count
[pscustomobject]@{ installations=@($installations); startup=@($startup); shortcuts=@($shortcuts); activeProcesses=$activeProcesses } | ConvertTo-Json -Depth 4 -Compress
`;
  const output = await run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { label: "Read-only installation preflight", timeout: 20_000 },
  );
  const result = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  assert.ok(
    Array.isArray(result.installations) && Array.isArray(result.startup),
    "registry preflight returned invalid data",
  );
  return result;
}
function assertOwnedRegistration(entries, version) {
  assert.ok(entries.length > 0, "installer did not register an uninstall entry");
  for (const entry of entries) {
    const executable = /^"([^\"]+)"/.exec(entry.uninstall)?.[1];
    assert.ok(
      executable && inside(installRoot, executable),
      "installer registration points outside its isolated destination",
    );
    if (entry.location)
      assert.ok(
        samePath(entry.location, installRoot),
        "installer ignored the isolated destination",
      );
    if (version)
      assert.equal(
        entry.version,
        version,
        "installed registry version does not match the requested package",
      );
  }
}
async function install(file, version) {
  stage = `install-${version}`;
  assert.equal(
    (await registry()).activeProcesses,
    0,
    "a MediaVault process is already running; refusing NSIS process handling",
  );
  installed = true; // Also attempt scoped cleanup after a partially completed installer.
  await run(file, ["/S", `/D=${installRoot}`], {
    label: `NSIS ${version} installation`,
    nsis: true,
    timeout: 180_000,
  });
  const records = await until(
    "installed executable and registry",
    async () => ({
      ready: await exists(installedExecutable),
      records: (await registry()).installations,
    }),
    (result) => result.ready && result.records.length > 0,
    60_000,
  );
  assertOwnedRegistration(records.records, version);
  installedVersions.push(version);
  steps.push(`installed-${version}`);
}
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_PATH",
    "NODE_OPTIONS",
    "MEDIAVAULT_DEV_URL",
    "MEDIAVAULT_USER_DATA",
    "MEDIAVAULT_VIDEOS_DIR",
    "MEDIAVAULT_YTDLP_PATH",
    "MEDIAVAULT_FFMPEG_PATH",
    "MEDIAVAULT_FFPROBE_PATH",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ])
    delete env[key];
  return env;
}
async function launch(version) {
  application = await electron.launch({
    executablePath: installedExecutable,
    args: [
      `--user-data-dir=${profile}`,
      `--media-videos-dir=${videos}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
    cwd: installRoot,
    env: cleanEnvironment(),
    timeout: 30_000,
  });
  page = await until(
    "installed application renderer",
    async () =>
      application.windows().find((window) => window.url().startsWith("mediavault://app/")),
    Boolean,
  );
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => Boolean(window.mediaVault?.product));
  const actual = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    executable: process.execPath,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    videos: app.getPath("videos"),
  }));
  assert.equal(actual.packaged, true);
  assert.equal(actual.version, version);
  assert.ok(samePath(actual.executable, installedExecutable));
  assert.ok(samePath(actual.userData, profile));
  assert.ok(samePath(actual.videos, videos));
  return actual;
}
async function value(group, method, ...arguments_) {
  const result = await page.evaluate(
    async ({ group, method, arguments_ }) => window.mediaVault[group][method](...arguments_),
    { group, method, arguments_ },
  );
  assert.equal(result.ok, true, `${group}.${method} failed`);
  return result.value;
}
const loginArguments = () => [
  "--background",
  `--user-data-dir=${profile}`,
  `--media-videos-dir=${videos}`,
];
async function restoreStartup() {
  if (!startupTouched) return;
  if (!application) await launch(installedVersions.at(-1));
  const disabled = await application.evaluate(({ app }, args) => {
    app.setLoginItemSettings({
      openAtLogin: false,
      enabled: false,
      path: process.execPath,
      args,
      name: "com.mediavault.desktop",
    });
    const current = app.getLoginItemSettings({ path: `"${process.execPath}"`, args });
    return !current.openAtLogin && !current.executableWillLaunchAtLogin;
  }, loginArguments());
  assert.equal(disabled, true, "the isolated startup entry could not be disabled");
  startupTouched = false;
}
async function parsedStartupCommand() {
  // Read only our freshly created AUMID value; native parsing verifies actual Windows startup flags.
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MediaVaultStartupCommand {
  [DllImport("shell32.dll", SetLastError=true)] private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command,out int count);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
  public static string[] Parse(string command) {
    int count;
    IntPtr pointer=CommandLineToArgvW(command,out count);
    if(pointer==IntPtr.Zero) throw new InvalidOperationException();
    try {
      var result=new string[count];
      for(int n=0;n<count;n++) result[n]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,n*IntPtr.Size));
      return result;
    } finally { LocalFree(pointer); }
  }
}
'@
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
if (-not $key) { throw 'Missing isolated startup registration.' }
try {
  $value=[string]$key.GetValue('com.mediavault.desktop')
  if (-not $value) { throw 'Missing isolated startup registration.' }
  [MediaVaultStartupCommand]::Parse($value) | ConvertTo-Json -Compress
} finally { $key.Dispose() }
`;
  const output = await run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { label: "Native startup command verification", timeout: 20_000 },
  );
  return JSON.parse(output.trim().replace(/^\uFEFF/, ""));
}
async function closeApplication() {
  if (!application) return;
  const closing = application;
  try {
    const closed = closing.waitForEvent("close", { timeout: 30_000 });
    await closing.evaluate(({ app }) => app.quit()).catch(() => {});
    await closed;
  } catch {
    await terminateTree(closing.process().pid);
    throw new Error("Installed application did not drain and exit normally.");
  } finally {
    application = undefined;
    page = undefined;
  }
}
async function databaseState() {
  return application.evaluate(({ app }) => {
    const path = process.getBuiltinModule("node:path");
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(path.join(app.getAppPath(), "package.json"));
    const SQLite = load("better-sqlite3");
    const database = new SQLite(path.join(app.getPath("userData"), "mediavault.db"), {
      readonly: true,
    });
    try {
      const read = (key) =>
        JSON.parse(
          database.prepare("SELECT value_json FROM settings WHERE key=?").get(key).value_json,
        );
      return {
        schema: database.pragma("user_version", { simple: true }),
        ids: database
          .prepare("SELECT id FROM media ORDER BY id")
          .all()
          .map((row) => row.id),
        language: read("language"),
        product: read("product"),
        nativeLoaded: Object.keys(load.cache).some(
          (file) =>
            /better-sqlite3[\\/].*\.node$/i.test(file) && file.startsWith(process.resourcesPath),
        ),
      };
    } finally {
      database.close();
    }
  });
}
async function uninstall() {
  if (!installed) return;
  const registered = await registry();
  assert.equal(
    registered.activeProcesses,
    0,
    "a MediaVault process is running; refusing NSIS process handling",
  );
  const records = registered.installations;
  if (records.length) assertOwnedRegistration(records);
  const files = await readdir(installRoot).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const names = files.filter((name) => /^Uninstall.*\.exe$/i.test(name));
  if (!names.length && !records.length && !(await exists(installedExecutable))) {
    installed = false;
    cleanupVerified = true;
    return;
  }
  assert.equal(names.length, 1, "a unique isolated uninstaller was not found");
  const uninstaller = join(installRoot, names[0]);
  assert.ok(
    (await lstat(uninstaller)).isFile() && samePath(await realpath(uninstaller), uninstaller),
    "uninstaller must be an owned regular file",
  );
  await run(uninstaller, ["/S", `_?=${installRoot}`], {
    label: "NSIS uninstall",
    nsis: true,
    timeout: 180_000,
  });
  await until(
    "executable and uninstall registration removal",
    async () => !(await exists(installedExecutable)) && !(await registry()).installations.length,
    Boolean,
    60_000,
  );
  installed = false;
  cleanupVerified = true;
}

try {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Installer acceptance requires Windows x64.");
  if (
    args.length !== 2 ||
    args.some((arg) => !arg.startsWith("--baseline=") && !arg.startsWith("--upgrade="))
  )
    throw new Error(
      "Expected --baseline=<absolute installer> and --upgrade=<absolute installer>; use --help.",
    );
  const baseline = installerArgument("baseline"),
    upgrade = installerArgument("upgrade");
  assert.ok(!samePath(baseline, upgrade), "baseline and upgrade must be separate built installers");
  for (const file of [baseline, upgrade])
    assert.ok((await lstat(file)).isFile(), "requested installer is missing or not a regular file");
  const before = await registry();
  assert.equal(
    before.shortcuts.length,
    0,
    "existing MediaVault Desktop or Start Menu shortcut detected; nothing was installed or changed",
  );
  assert.equal(
    before.activeProcesses,
    0,
    "an existing MediaVault process is running; nothing was installed or changed",
  );
  assert.equal(
    before.installations.length,
    0,
    "existing MediaVault installation detected; nothing was installed or changed",
  );
  startupAllowed = before.startup.length === 0;
  startupBefore = before.startup;
  scratch = await mkdtemp(join(tmpdir(), "mediavault-installer-"));
  installRoot = join(scratch, "MediaVault Tiếng Việt 日本語");
  profile = join(scratch, "isolated profile");
  videos = join(scratch, "media Tiếng Việt 日本語");
  installedExecutable = join(installRoot, "MediaVault.exe");
  assert.ok(inside(scratch, installRoot) && inside(scratch, profile) && inside(scratch, videos));
  await mkdir(profile);
  await mkdir(videos);
  steps.push("clean-installation-preflight");
  await install(baseline, "0.1.0");
  stage = "baseline-data";
  const fixture = join(videos, "Generated fixture Tiếng Việt 日本語.mp4");
  await run(
    join(installRoot, "resources", "bin", "ffmpeg.exe"),
    [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-n",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      fixture,
    ],
    { label: "Bundled FFmpeg fixture generation", timeout: 30_000 },
  );
  assert.ok((await stat(fixture)).size > 0);
  await launch("0.1.0");
  assert.equal(await value("product", "getVersion"), "0.1.0");
  const defaults = await value("settings", "getProduct");
  assert.equal(defaults.startWithWindows, false, "fresh isolated install enabled startup");
  await value("settings", "setLanguage", "vi");
  await page.evaluate(() => localStorage.setItem("mv-lang", "vi"));
  await value("settings", "updateProduct", {
    closeBehavior: "exit",
    startWithWindows: false,
    theme: "light",
  });
  await value("settings", "completeFirstLaunch");
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, fixture);
  assert.deepEqual(await value("library", "addFile"), { added: 1, skipped: 0, failed: 0 });
  const media = await value("library", "list");
  assert.equal(media.length, 1);
  assert.ok(samePath(media[0].localPath, fixture));
  const original = await databaseState();
  assert.equal(original.schema, 3);
  assert.equal(original.nativeLoaded, true);
  assert.equal(original.language, "vi");
  assert.equal(original.product.firstLaunchCompleted, true);
  steps.push("baseline-native-sqlite-settings-and-media");
  if (startupAllowed) {
    stage = "startup-registration";
    assert.equal(defaults.startupSupported, true);
    startupTouched = true;
    assert.equal(
      (
        await value("settings", "updateProduct", {
          closeBehavior: "exit",
          startWithWindows: true,
          theme: "light",
        })
      ).startWithWindows,
      true,
    );
    const enabled = await application.evaluate(
      ({ app }, args) => app.getLoginItemSettings({ path: `"${process.execPath}"`, args }),
      loginArguments(),
    );
    assert.equal(enabled.openAtLogin, true);
    assert.equal(enabled.executableWillLaunchAtLogin, true);
    assert.ok(
      enabled.launchItems.some(
        (item) =>
          item.name === "com.mediavault.desktop" &&
          item.scope === "user" &&
          item.enabled &&
          samePath(item.path, installedExecutable),
      ),
      "startup did not enable the owned application entry",
    );
    assert.deepEqual(
      await parsedStartupCommand(),
      [installedExecutable, ...loginArguments()],
      "Windows startup arguments did not preserve the isolated profile and media paths",
    );
    assert.ok((await registry()).startup.length > 0);
    assert.equal(
      (
        await value("settings", "updateProduct", {
          closeBehavior: "exit",
          startWithWindows: false,
          theme: "light",
        })
      ).startWithWindows,
      false,
    );
    await restoreStartup();
    assert.equal((await registry()).startup.length, 0);
    steps.push("actual-startup-on-off");
  } else steps.push("startup-check-skipped-existing-entry-preserved");
  await closeApplication();
  await install(upgrade, "0.1.1");
  stage = "upgrade-persistence";
  await launch("0.1.1");
  assert.equal(await value("product", "getVersion"), "0.1.1");
  const maintenance = await value("maintenance", "get");
  assert.equal(maintenance.app.currentVersion, "0.1.1");
  assert.equal(maintenance.app.latestVersion, null, "upgrade silently checked the update feed");
  assert.equal(maintenance.app.status, maintenance.app.configured ? "idle" : "unconfigured");
  const diagnostics = await value("diagnostics", "get");
  assert.equal(diagnostics.appVersion, "0.1.1");
  assert.equal(diagnostics.schemaVersion, 3);
  assert.ok(samePath(diagnostics.databasePath, join(profile, "mediavault.db")));
  for (const tool of ["ytDlp", "ffmpeg", "ffprobe"])
    assert.equal(diagnostics.binaries[tool].available, true);
  steps.push("upgrade-maintenance-and-diagnostics");
  const preserved = await databaseState();
  assert.equal(preserved.schema, 3);
  assert.equal(preserved.nativeLoaded, true);
  assert.deepEqual(preserved.ids, original.ids);
  assert.equal(preserved.language, "vi");
  assert.deepEqual(preserved.product, original.product);
  assert.equal((await value("settings", "getProduct")).startWithWindows, false);
  assert.equal(await page.evaluate(() => localStorage.getItem("mv-lang")), "vi");
  const upgradedMedia = await value("library", "list");
  assert.deepEqual(
    upgradedMedia.map((item) => item.id),
    media.map((item) => item.id),
  );
  assert.ok(samePath(upgradedMedia[0].localPath, fixture));
  await closeApplication();
  steps.push("upgrade-preserved-profile-settings-and-media");
  const databaseFile = join(profile, "mediavault.db");
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const databaseBefore = await digest(databaseFile),
    mediaBefore = await digest(fixture);
  stage = "uninstall-retention";
  await uninstall();
  const afterUninstall = await registry();
  assert.equal(
    JSON.stringify(afterUninstall.startup),
    JSON.stringify(startupBefore),
    "uninstall changed an existing startup entry",
  );
  assert.equal(
    afterUninstall.shortcuts.length,
    0,
    "uninstall retained an installed Desktop or Start Menu shortcut",
  );
  assert.equal(
    await digest(databaseFile),
    databaseBefore,
    "uninstall changed or removed the isolated profile database",
  );
  assert.equal(
    await digest(fixture),
    mediaBefore,
    "uninstall changed or removed the generated media",
  );
  const retained = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(
      retained
        .prepare("SELECT id FROM media ORDER BY id")
        .all()
        .map((row) => row.id),
      original.ids,
    );
  } finally {
    retained.close();
  }
  steps.push("uninstall-removed-app-and-registry-preserved-profile-and-media");
  passed = true;
  stage = "complete";
} catch (error) {
  failure = error instanceof Error ? error.message : "Installer verification failed.";
  process.exitCode = 1;
  console.error(`[installer test] FAIL at ${stage}: ${failure}`);
} finally {
  try {
    await restoreStartup();
  } catch {
    cleanupErrors.push("isolated-startup-registration-could-not-be-restored");
  }
  try {
    await closeApplication();
  } catch {
    cleanupErrors.push("installed-application-required-process-tree-termination");
  }
  try {
    await uninstall();
  } catch {
    cleanupErrors.push("isolated-uninstall-did-not-finish");
  }
  if (cleanupErrors.length) {
    passed = false;
    process.exitCode = 1;
  }
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(
    artifact,
    JSON.stringify(
      {
        passed,
        stage,
        ...(failure ? { failure } : {}),
        installedVersions,
        steps,
        startupTest: steps.includes("actual-startup-on-off")
          ? "enabled-then-disabled"
          : steps.includes("startup-check-skipped-existing-entry-preserved")
            ? "skipped-existing-entry"
            : "not-run",
        cleanupVerified,
        cleanupErrors,
        ...(scratch ? { scratch } : {}),
        scope: "generated local media, isolated profile and temporary installation only",
      },
      null,
      2,
    ),
  );
  if (passed && scratch) {
    const temporaryRoot = await realpath(tmpdir()),
      actualScratch = await realpath(scratch);
    assert.ok(
      inside(temporaryRoot, actualScratch) &&
        samePath(actualScratch, scratch) &&
        relative(temporaryRoot, actualScratch).startsWith("mediavault-installer-"),
      "refusing cleanup outside the owned temporary root",
    );
    await rm(actualScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(
      `[installer test] PASS: baseline install, ${startupAllowed ? "real startup toggle, " : "existing startup entry preserved, "}upgrade persistence and uninstall retention verified.`,
    );
  } else if (scratch)
    console.error(`[installer test] Generated evidence retained for inspection: ${scratch}`);
}
