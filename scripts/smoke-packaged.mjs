// Runs the built Windows executable with generated media and isolated profiles.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runExecutable = promisify(execFile);
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/smoke-packaged.mjs [--executable <MediaVault.exe>]\nDefault: release/win-unpacked/MediaVault.exe\nCopies the app to an isolated path containing spaces, Tiếng Việt and 日本語, then runs the full local desktop smoke. No installer, real media, Google login or installed app profile is used.\nSet MEDIAVAULT_SMOKE_ARTIFACTS to select evidence output, or MEDIAVAULT_EXPECTED_VERSION for a staged upgrade build.",
  );
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("Packaged smoke currently requires Windows x64.");
if (args.length && (args.length !== 2 || args[0] !== "--executable" || !args[1]))
  throw new Error("Expected --executable <MediaVault.exe>; use --help for usage.");
const sourceExecutable = resolve(
  args[1] ?? join(root, "release", "win-unpacked", "MediaVault.exe"),
);
await access(sourceExecutable).catch(() => {
  throw new Error(
    "Packaged executable is missing. Build the Windows package before running this test.",
  );
});
assert.equal(
  (await lstat(sourceExecutable)).isFile(),
  true,
  "packaged executable must be a regular file",
);
const sourceDirectory = dirname(sourceExecutable);
await access(join(sourceDirectory, "resources", "app.asar"));
const artifacts = resolve(
  process.env.MEDIAVAULT_SMOKE_ARTIFACTS ?? join(root, "artifacts", "milestone-c"),
);
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "mediavault-package-"));
const copiedDirectory = join(temporary, "MediaVault Tiếng Việt 日本語");
const copiedExecutable = join(copiedDirectory, basename(sourceExecutable));
let safeToRemoveCopy = true;

async function inventory(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(
      entry.isSymbolicLink(),
      false,
      "package contains an unexpected filesystem redirect",
    );
    if (entry.isDirectory()) files.push(...(await inventory(path, name)));
    else if (entry.isFile()) {
      const info = await lstat(path);
      files.push({ name, size: info.size, modifiedAt: info.mtimeMs });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

try {
  console.log("[packaged smoke] Copying the packaged application to a Unicode path with spaces.");
  await cp(sourceDirectory, copiedDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  const before = await inventory(copiedDirectory);
  safeToRemoveCopy = false;
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "scripts", "smoke-electron.mjs"), "--packaged-executable", copiedExecutable],
      {
        cwd: root,
        env: { ...process.env, MEDIAVAULT_SMOKE_ARTIFACTS: artifacts },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    let timedOut = false;
    let termination = Promise.resolve();
    const deadline = setTimeout(() => {
      timedOut = true;
      const windowsDirectory = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      termination = child.pid
        ? runExecutable(
            join(windowsDirectory, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 },
          ).then(
            () => {},
            () => {},
          )
        : Promise.resolve();
      void termination.then(() =>
        reject(
          new Error(
            "Packaged smoke exceeded its 10-minute deadline; termination was requested for its owned process tree.",
          ),
        ),
      );
    }, 10 * 60_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      void termination.then(() =>
        timedOut
          ? reject(new Error("Packaged smoke exceeded its 10-minute deadline."))
          : resolveExit(code ?? 1),
      );
    });
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    throw new Error(`Packaged workflow failed with exit code ${exitCode}.`);
  }
  // The full harness awaits explicit application exit before its process returns.
  safeToRemoveCopy = true;
  assert.deepEqual(
    await inventory(copiedDirectory),
    before,
    "the app wrote mutable data into its install directory",
  );
  await writeFile(
    join(artifacts, "packaged-result.json"),
    JSON.stringify(
      {
        exitCode: 0,
        sourceExecutable,
        testedExecutable: copiedExecutable,
        copiedPathContainsSpaces: true,
        copiedPathContainsVietnamese: true,
        copiedPathContainsJapanese: true,
        packageUnchanged: true,
        packagedFiles: before.length,
        fixtureScope: "generated local media and isolated profiles only",
      },
      null,
      2,
    ),
  );
  console.log(
    "[packaged smoke] PASS: real packaged executable and bundled tools work from the Unicode path; install files remain unchanged.",
  );
} catch (error) {
  console.error(`[packaged smoke] FAIL: ${error.message}`);
  process.exitCode ||= 1;
} finally {
  if (safeToRemoveCopy) {
    const local = relative(resolve(tmpdir()), resolve(temporary));
    assert.ok(
      !isAbsolute(local) &&
        local !== ".." &&
        !local.startsWith(`..${sep}`) &&
        local.startsWith("mediavault-package-"),
    );
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } else
    console.error(
      `[packaged smoke] Retained generated package copy for failure inspection: ${temporary}`,
    );
}
