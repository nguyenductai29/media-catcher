export interface StartupPathsOptions {
  argv: readonly string[];
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  installDirectory: string;
  defaultUserData: string;
  defaultVideos: string;
  env: Readonly<Record<string, string | undefined>>;
}

function absolutePath(value: string): string {
  if (!value || !isAbsolute(value) || /\p{Cc}/u.test(value)) throw new Error("startupFailed");
  if (process.platform === "win32") {
    const normalized = value.replaceAll("/", "\\");
    // A root-relative drive path and device namespaces depend on ambient process state.
    if (
      /^\\\\[?.]\\/.test(normalized) ||
      (!/^[a-z]:\\/i.test(normalized) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized))
    )
      throw new Error("startupFailed");
  }
  return resolve(value);
}

function switchValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  let selected: string | undefined;
  for (const argument of argv) {
    if (argument === `--${name}`) throw new Error("startupFailed");
    if (!argument.startsWith(prefix)) continue;
    if (selected !== undefined) throw new Error("startupFailed");
    selected = argument.slice(prefix.length);
    if (!selected) throw new Error("startupFailed");
  }
  return selected;
}

/** Resolve redirects without creating a profile before Electron is ready. */
function canonicalPath(path: string, requireDirectory: boolean): string {
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const entry = lstatSync(ancestor);
      // realpath must succeed for an existing symlink; dangling links never become writable paths.
      const canonical = realpathSync(ancestor);
      const info = entry.isSymbolicLink() ? statSync(canonical) : entry;
      if ((requireDirectory || missing.length > 0) && !info.isDirectory())
        throw new Error("startupFailed");
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // lstat distinguishes an absent component from an existing dangling redirect.
      if (lstatSync(ancestor, { throwIfNoEntry: false })) throw new Error("startupFailed");
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("startupFailed");
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
function inside(root: string, path: string): boolean {
  const child = relative(key(root), key(path));
  return (
    child === "" ||
    (child !== ".." && !child.startsWith("..\\") && !child.startsWith("../") && !isAbsolute(child))
  );
}

/** Main-only startup overrides. Packaged apps ignore development environment variables. */
export function resolveStartupPaths(options: StartupPathsOptions): {
  userData: string;
  videos: string;
} {
  try {
    const userData =
      switchValue(options.argv, "user-data-dir") ??
      (!options.packaged ? options.env["MEDIAVAULT_USER_DATA"] : undefined) ??
      options.defaultUserData;
    const videos =
      switchValue(options.argv, "media-videos-dir") ??
      (!options.packaged ? options.env["MEDIAVAULT_VIDEOS_DIR"] : undefined) ??
      options.defaultVideos;
    const protectedPaths = [
      options.appPath,
      options.resourcesPath,
      options.installDirectory,
    ].flatMap((path) => {
      const absolute = absolutePath(path);
      return [absolute, canonicalPath(absolute, false)];
    });
    const validate = (value: string) => {
      const absolute = absolutePath(value);
      if (protectedPaths.some((root) => inside(root, absolute))) throw new Error("startupFailed");
      const canonical = canonicalPath(absolute, true);
      if (protectedPaths.some((root) => inside(root, canonical))) throw new Error("startupFailed");
      return canonical;
    };
    const selectedUserData = validate(userData),
      selectedVideos = validate(videos);
    // The videos option is a parent directory; this is the actual writable app-owned root.
    validate(join(selectedVideos, "MediaVault"));
    return { userData: selectedUserData, videos: selectedVideos };
  } catch (cause) {
    throw new Error("startupFailed", { cause });
  }
}
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
