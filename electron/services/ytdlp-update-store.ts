import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface YtDlpPointer {
  version: string;
  file: string;
  sha256: string;
}
export const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const ownedTemporary =
  /^\.yt-dlp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:partial\.exe|pointer\.tmp)$/;

export function validReleaseVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^20\d{2}\.\d{2}\.\d{2}(?:\.\d{1,3})?$/.test(value))
    return false;
  const [year, month, day] = value.split(".").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("cancelled");
}

export async function updateDirectory(userData: string, create = false): Promise<string> {
  if (!isAbsolute(userData)) throw new Error("updateFailed");
  const parent = await lstat(userData);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("updateFailed");
  const directory = join(userData, "bin");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("updateFailed");
  return directory;
}

/** Only a bounded, regular file inside the owned directory may become an executable. */
export async function hashExecutable(path: string, signal?: AbortSignal): Promise<string> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(MAX_BINARY_BYTES)
  )
    throw new Error("updateFailed");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat({ bigint: true });
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size)
      throw new Error("updateFailed");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BINARY_BYTES) throw new Error("updateFailed");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(total) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new Error("updateFailed");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function isPointer(value: unknown): value is YtDlpPointer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    validReleaseVersion(v["version"]) &&
    typeof v["sha256"] === "string" &&
    /^[a-f0-9]{64}$/.test(v["sha256"]) &&
    v["file"] === `yt-dlp-${v["version"]}-${v["sha256"]}.exe`
  );
}

/** Corrupt or incomplete updates fall back to the shipped binary; they are never executed. */
export async function readActiveUpdate(userData: string): Promise<string | undefined> {
  try {
    const directory = await updateDirectory(userData);
    const pointerPath = join(directory, "yt-dlp-active.json");
    const info = await lstat(pointerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_048) return undefined;
    const handle = await open(pointerPath, "r");
    let value: unknown;
    try {
      const bytes = Buffer.alloc(2_049);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 2_048) return undefined;
      value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
    } finally {
      await handle.close();
    }
    if (!isPointer(value)) return undefined;
    const executable = join(directory, value.file);
    return (await hashExecutable(executable)) === value.sha256 ? executable : undefined;
  } catch {
    return undefined;
  }
}

export async function cleanupUpdateStages(userData: string): Promise<void> {
  const directory = await updateDirectory(userData, true);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ownedTemporary.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
      await unlink(join(directory, entry.name));
    }
  }
}

export async function retainVerifiedExecutable(
  userData: string,
  stage: string,
  pointer: YtDlpPointer,
  signal: AbortSignal,
): Promise<void> {
  const directory = await updateDirectory(userData);
  if (!isPointer(pointer) || !ownedTemporary.test(stage) || !stage.endsWith(".partial.exe"))
    throw new Error("updateFailed");
  throwIfAborted(signal);
  const source = join(directory, stage);
  const target = join(directory, pointer.file);
  try {
    await link(source, target);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  if ((await hashExecutable(target, signal)) !== pointer.sha256)
    throw new Error("updateChecksumMismatch");
}

/** The only mutable item is a fsynced, atomically replaced pointer to immutable verified bytes. */
export async function activateUpdate(
  userData: string,
  pointer: YtDlpPointer,
  signal?: AbortSignal,
): Promise<void> {
  if (!isPointer(pointer)) throw new Error("updateFailed");
  const directory = await updateDirectory(userData);
  const temporary = join(directory, `.yt-dlp-${randomUUID()}.pointer.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(pointer));
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    await rename(temporary, join(directory, "yt-dlp-active.json"));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
