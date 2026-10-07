import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const binaryNames = ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"];
const runtimeDependencies = ["better-sqlite3", "electron-updater"];
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const assetExtensions = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".svg",
  ".png",
  ".ico",
  ".webp",
  ".jpg",
  ".jpeg",
  ".woff",
  ".woff2",
  ".ttf",
]);

function inside(root, path) {
  const absolute = resolve(path);
  const part = relative(root, absolute);
  if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error("Packaging path must be confined to its project directory.");
  }
  return absolute;
}

// Reject junctions as well as file symlinks before any source read or output deletion.
async function checked(root, path, kind) {
  const absolute = inside(root, path);
  const parts = relative(root, absolute).split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error("Packaging cannot follow a symbolic link or junction.");
    const last = index === parts.length - 1;
    if ((!last || kind === "directory") && !stat.isDirectory())
      throw new Error("Expected a packaging directory.");
    if (last && kind === "file" && !stat.isFile())
      throw new Error("Expected a regular packaging file.");
  }
  return absolute;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function json(root, path) {
  const bytes = await readFile(await checked(root, path, "file"));
  if (bytes.length > 1024 * 1024) throw new Error("Packaging metadata is too large.");
  return JSON.parse(bytes.toString("utf8"));
}

async function copy(root, source, destination) {
  await checked(root, source, "file");
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function copyTree(root, source, destination, include = () => true, prefix = "") {
  await checked(root, source, "directory");
  await mkdir(destination, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!include(path, entry.isDirectory())) continue;
    if (entry.isDirectory())
      await copyTree(root, join(source, entry.name), join(destination, entry.name), include, path);
    else await copy(root, join(source, entry.name), join(destination, entry.name));
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

function manifestRecords(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.platform !== "win32" ||
    manifest.arch !== "x64" ||
    !Array.isArray(manifest.binaries) ||
    manifest.binaries.length !== binaryNames.length
  ) {
    throw new Error("Invalid bundled binary manifest.");
  }
  const names = new Set();
  for (const binary of manifest.binaries) {
    if (
      !binary ||
      !binaryNames.includes(binary.file) ||
      names.has(binary.file) ||
      !Number.isSafeInteger(binary.bytes) ||
      binary.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(binary.sha256) ||
      typeof binary.version !== "string" ||
      !/^\d+(?:\.\d+){1,3}$/.test(binary.version) ||
      !Array.isArray(binary.licenseFiles) ||
      binary.licenseFiles.length === 0 ||
      binary.licenseFiles.some(
        (file) =>
          typeof file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:txt|md)$/.test(file),
      )
    ) {
      throw new Error("Invalid bundled binary manifest entry.");
    }
    names.add(binary.file);
  }
  return manifest.binaries;
}

async function installedPackage(root, name, from) {
  if (!packageName.test(name)) throw new Error("Invalid runtime dependency name.");
  let current = from;
  while (true) {
    const candidate = join(current, "node_modules", name);
    if (await exists(candidate)) {
      await checked(root, candidate, "directory");
      return candidate;
    }
    if (current === root) break;
    current = dirname(current);
    if (current !== root) inside(root, current);
  }
  throw new Error(`Required runtime dependency is missing: ${name}`);
}

async function stageDependency(root, name, from, appDirectory, visited) {
  const source = await installedPackage(root, name, from);
  if (visited.has(source)) return visited.get(source);
  const metadata = await json(root, join(source, "package.json"));
  if (metadata.name !== name || typeof metadata.version !== "string")
    throw new Error("Invalid installed runtime dependency metadata.");
  visited.set(source, metadata.version);
  const destination = join(appDirectory, relative(root, source));
  if (name === "better-sqlite3") {
    if (metadata.version !== "13.0.3")
      throw new Error("Revalidate native SQLite packaging before changing its pinned version.");
    await copy(root, join(source, "package.json"), join(destination, "package.json"));
    await copy(root, join(source, "LICENSE"), join(destination, "LICENSE"));
    await copyTree(
      root,
      join(source, "lib"),
      join(destination, "lib"),
      (path, directory) => directory || path.endsWith(".js"),
    );
    await copy(
      root,
      join(source, "prebuilds/win32-x64.node"),
      join(destination, "prebuilds/win32-x64.node"),
    );
  } else {
    await copyTree(
      root,
      source,
      destination,
      (path) =>
        !path
          .split("/")
          .some(
            (part) =>
              part.startsWith(".") ||
              ["node_modules", "test", "tests", "__tests__", "examples"].includes(part),
          ) && !path.endsWith(".map"),
    );
  }
  for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) {
    await stageDependency(root, dependency, source, appDirectory, visited);
  }
  return metadata.version;
}

async function collectNpmNotices(root, dependencies, destination) {
  const visited = new Set();
  const index = [];
  const supplementsPath = join(root, "resources/notices/npm-supplements.json");
  const supplements = (await exists(supplementsPath)) ? await json(root, supplementsPath) : [];
  if (
    !Array.isArray(supplements) ||
    supplements.some(
      (item) =>
        !item ||
        typeof item.package !== "string" ||
        typeof item.version !== "string" ||
        typeof item.file !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:txt|md)$/.test(item.file),
    )
  )
    throw new Error("Invalid supplemental license manifest.");
  async function collect(name, from) {
    const source = await installedPackage(root, name, from);
    if (visited.has(source)) return;
    visited.add(source);
    const metadata = await json(root, join(source, "package.json"));
    const files = [];
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!/^(?:licen[cs]e|copying|notice|ofl)(?:[._-]|$)/i.test(entry.name)) continue;
      const path = join(relative(root, source), entry.name);
      if (entry.isDirectory())
        await copyTree(root, join(source, entry.name), join(destination, path));
      else await copy(root, join(source, entry.name), join(destination, path));
      files.push(path.split(sep).join("/"));
    }
    const vendored = join(source, "lib-vendor");
    if (await exists(vendored)) {
      await copyTree(
        root,
        vendored,
        join(destination, relative(root, vendored)),
        (path, directory) =>
          directory ||
          /^(?:licen[cs]e|copying|notice|ofl)(?:[._-]|$)/i.test(path.split("/").at(-1)),
      );
      files.push(`${relative(root, vendored).split(sep).join("/")}/`);
    }
    for (const supplement of supplements.filter(
      (item) => item.package === metadata.name && item.version === metadata.version,
    )) {
      await checked(root, join(root, "resources/notices", supplement.file), "file");
      files.push(`../${supplement.file}`);
    }
    index.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? "See upstream package",
      repository: metadata.repository,
      files,
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort())
      await collect(dependency, source);
  }
  for (const name of Object.keys(dependencies).sort()) await collect(name, root);
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "index.json"),
    JSON.stringify(
      index.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)),
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}

async function removeOutput(root, path) {
  if (!(await exists(path))) return;
  await checked(root, path, "directory");
  // Every caller supplies a fixed direct child of the checked artifacts directory.
  await rm(path, { recursive: true, force: true });
}

/** Build an offline, minimal Windows x64 app tree without modifying installed dependencies. */
export async function preparePackaging({ root = defaultRoot } = {}) {
  root = await realpath(resolve(root));
  const metadata = await json(root, join(root, "package.json"));
  if (
    metadata.name !== "mediavault" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)
  )
    throw new Error("Invalid MediaVault package metadata.");
  const manifest = await json(root, join(root, "resources/notices/binaries.json"));
  const binaries = manifestRecords(manifest);
  const artifacts = join(root, "artifacts");
  if (!(await exists(artifacts))) await mkdir(artifacts);
  await checked(root, artifacts, "directory");
  const stage = join(artifacts, `.package-stage-${randomUUID()}`);
  await mkdir(stage);
  const appDirectory = join(artifacts, "package-app");
  const resourcesDirectory = join(artifacts, "package-resources");
  const stagedApp = join(stage, "package-app");
  const stagedResources = join(stage, "package-resources");
  try {
    for (const file of ["main.cjs", "preload.cjs"])
      await copy(root, join(root, "dist-electron", file), join(stagedApp, "dist-electron", file));
    await copyTree(
      root,
      join(root, "dist-desktop"),
      join(stagedApp, "dist-desktop"),
      (path, directory) =>
        !path
          .split("/")
          .some(
            (part) =>
              part.startsWith(".") ||
              /^(?:client_secret|credentials|auth|cookies?)(?:[._-]|$)/i.test(part),
          ) &&
        (directory || assetExtensions.has(extname(path)) || path === "robots.txt"),
    );
    await checked(root, join(stagedApp, "dist-desktop/index.html"), "file");
    const dependencies = {};
    const visited = new Map();
    for (const name of runtimeDependencies)
      dependencies[name] = await stageDependency(root, name, root, stagedApp, visited);
    await writeFile(
      join(stagedApp, "package.json"),
      JSON.stringify(
        {
          name: metadata.name,
          productName: metadata.productName,
          version: metadata.version,
          description: metadata.description,
          author: metadata.author,
          repository: metadata.repository,
          main: "dist-electron/main.cjs",
          private: true,
          type: "commonjs",
          dependencies,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await copyTree(
      root,
      join(root, "resources/notices"),
      join(stagedResources, "notices"),
      (path, directory) => directory || [".txt", ".md", ".json"].includes(extname(path)),
    );
    await collectNpmNotices(
      root,
      metadata.dependencies ?? {},
      join(stagedResources, "notices/npm"),
    );
    await copy(
      root,
      join(root, "node_modules/better-sqlite3/LICENSE"),
      join(stagedResources, "notices/better-sqlite3-LICENSE.txt"),
    );
    await copy(
      root,
      join(root, "node_modules/node-addon-api/LICENSE.md"),
      join(stagedResources, "notices/node-addon-api-LICENSE.md"),
    );
    for (const binary of binaries) {
      for (const license of binary.licenseFiles)
        await checked(root, join(root, "resources/notices", license), "file");
      const destination = join(stagedResources, "bin", binary.file);
      await copy(root, join(root, "resources/bin", binary.file), destination);
      if (
        (await lstat(destination)).size !== binary.bytes ||
        (await sha256(destination)) !== binary.sha256
      )
        throw new Error(`Bundled binary checksum does not match the manifest: ${binary.file}`);
    }
    for (const file of ["icon.ico", "installer.ico", "icon-256.png", "tray.png"])
      await copy(
        root,
        join(root, "resources/branding", file),
        join(stagedResources, "branding", file),
      );
    for (const destination of [
      join(stagedApp, "THIRD-PARTY-NOTICES.md"),
      join(stagedResources, "notices/THIRD-PARTY-NOTICES.md"),
    ])
      await copy(root, join(root, "THIRD-PARTY-NOTICES.md"), destination);
    await writeFile(
      join(stagedApp, "packaging.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          appVersion: metadata.version,
          platform: "win32",
          arch: "x64",
          binaries,
          native: {
            name: "better-sqlite3",
            version: dependencies["better-sqlite3"],
            file: "node_modules/better-sqlite3/prebuilds/win32-x64.node",
            sha256: await sha256(
              join(stagedApp, "node_modules/better-sqlite3/prebuilds/win32-x64.node"),
            ),
          },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    // Validation finishes before replacing either prior output. The builder runs only after success.
    await removeOutput(root, appDirectory);
    await removeOutput(root, resourcesDirectory);
    await rename(stagedApp, appDirectory);
    await rename(stagedResources, resourcesDirectory);
    return { appDirectory, resourcesDirectory };
  } finally {
    await removeOutput(root, stage);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePackaging().then(
    () => console.log("Verified Windows x64 package staging prepared in artifacts."),
    (error) => {
      console.error(error instanceof Error ? error.message : "Package staging failed.");
      process.exitCode = 1;
    },
  );
}
