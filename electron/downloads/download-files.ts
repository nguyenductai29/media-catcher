import { constants } from "node:fs";
import { copyFile, link, lstat, realpath, statfs } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { sanitizeFilename } from "../../shared/filenames";
export { sanitizeFilename } from "../../shared/filenames";

export function confinedPath(directory: string, child: string): string {
  if (!isAbsolute(directory) || isAbsolute(child) || /[:\p{Cc}]/u.test(child))
    throw new Error("invalidInput");
  const path = resolve(directory, child);
  const rel = relative(resolve(directory), path);
  if (!rel || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("invalidInput");
  return path;
}
export async function validateOwnedFile(directory: string, path: string): Promise<string> {
  try {
    const root = await realpath(directory);
    const file = await realpath(path);
    const rel = relative(root, file);
    confinedPath(root, rel);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error("fileMissing");
    return file;
  } catch (error) {
    if (error instanceof Error && ["invalidInput", "fileMissing"].includes(error.message))
      throw error;
    throw new Error(fileErrorCode(error) === "ENOENT" ? "fileMissing" : "fileAccessDenied");
  }
}
export async function publishFile(
  source: string,
  directory: string,
  title: string,
  extension: string,
): Promise<string> {
  // Even a valid media payload must not be published with an executable suffix
  // that a later explicit Open in default app action could launch as a program.
  if (
    !/^\.(mp4|mkv|webm|mov|avi|m4v|m4a|mka|mp3|aac|opus|ogg|ogv|weba|flac|wav|ts|mts|m2ts|mpeg|mpg|3gp|3g2|wmv|asf|flv|f4v|vob)$/i.test(
      extension,
    )
  )
    throw new Error("unsupportedFormat");
  const basename = sanitizeFilename(title);
  for (let count = 0; count < 10_000; count++) {
    const target = confinedPath(
      directory,
      `${basename}${count ? ` (${count})` : ""}${extension.toLowerCase()}`,
    );
    try {
      // An exclusive hard link publishes instantly on one volume. Exclusive
      // native copy handles other volumes without buffering media in memory.
      try {
        await link(source, target);
      } catch (error) {
        if (fileErrorCode(error) === "EEXIST") throw error;
        await copyFile(source, target, constants.COPYFILE_EXCL);
      }
      return target;
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST") continue;
      throw new Error(fileErrorCode(error) === "ENOSPC" ? "insufficientSpace" : "fileAccessDenied");
    }
  }
  throw new Error("fileAccessDenied");
}
export function fileErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
export async function availableBytes(directory: string): Promise<number> {
  try {
    const info = await statfs(directory);
    return info.bavail * info.bsize;
  } catch {
    throw new Error("fileAccessDenied");
  }
}
export async function assertFreeSpace(
  directory: string,
  bytes?: number,
  available = availableBytes,
): Promise<void> {
  const expected = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const reserve = Math.max(1024 ** 3, expected * 0.1);
  if ((await available(directory)) < expected + reserve) throw new Error("insufficientSpace");
}
