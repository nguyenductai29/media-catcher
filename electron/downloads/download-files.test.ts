// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFreeSpace,
  assertAtomicPublication,
  confinedPath,
  publishFile,
  sanitizeFilename,
  validateOwnedFile,
} from "./download-files";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("safe download files", () => {
  it("checks atomic-link support without retaining probe files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-files-"));
    roots.push(root);
    await assertAtomicPublication(root);
    expect(await readdir(root)).toEqual([]);
  });
  it("sanitizes Windows names, traversal and reserved device basenames", () => {
    for (const input of ["CON", "con.txt", "COM1", "LPT9.avi", "NUL.", "AUX ", "COM¹", "LPT³.mp4"])
      expect(sanitizeFilename(input)).toMatch(/^_/);
    expect(sanitizeFilename('../Movie<>:"/\\|?*\u0000... ')).toBe("Movie");
    expect(sanitizeFilename(".")).toBe("Media");
    expect(sanitizeFilename("x".repeat(400)).length).toBeLessThanOrEqual(120);
    expect(sanitizeFilename("Phim Tiếng Việt")).toBe("Phim Tiếng Việt");
  });
  it("rejects escaping and absolute child paths", () => {
    const root = join(tmpdir(), "mv-safe");
    expect(confinedPath(root, "movie.mp4")).toBe(join(root, "movie.mp4"));
    for (const child of ["../escape", join(tmpdir(), "outside"), "..\\escape", "file.mp4:stream"])
      expect(() => confinedPath(root, child)).toThrow("invalidInput");
  });
  it("publishes competing same-title files without overwriting an existing movie", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-files-"));
    roots.push(root);
    const source = join(root, "source.mp4");
    await writeFile(source, "new video");
    await writeFile(join(root, "Movie.mp4"), "existing video");
    const paths = await Promise.all([
      publishFile(source, root, "Movie", ".mp4"),
      publishFile(source, root, "Movie", ".mp4"),
    ]);
    expect(new Set(paths).size).toBe(2);
    expect(paths.sort()).toEqual([join(root, "Movie (1).mp4"), join(root, "Movie (2).mp4")]);
    expect(await readFile(join(root, "Movie.mp4"), "utf8")).toBe("existing video");
    expect(await readFile(paths[0]!, "utf8")).toBe("new video");
    await expect(publishFile(source, root, "Movie", ".exe")).rejects.toThrow("unsupportedFormat");
  });
  it("checks space for known bytes and safety reserve, including unknown-size jobs", async () => {
    await expect(assertFreeSpace("unused", 2_000, async () => 1_000)).rejects.toThrow(
      "insufficientSpace",
    );
    await expect(assertFreeSpace("unused", undefined, async () => 100)).rejects.toThrow(
      "insufficientSpace",
    );
    await expect(
      assertFreeSpace("unused", 1_000, async () => 10 * 1024 ** 3),
    ).resolves.toBeUndefined();
  });
  it("reports a safe missing-file error when a completed output is moved or deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-files-"));
    roots.push(root);
    await expect(validateOwnedFile(root, join(root, "missing.mp4"))).rejects.toThrow(
      /^fileMissing$/,
    );
  });
});
