// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateUpdate,
  cleanupUpdateStages,
  readActiveUpdate,
  retainVerifiedExecutable,
} from "./ytdlp-update-store";

describe("yt-dlp immutable update storage", () => {
  let directory: string;
  const contents = Buffer.from("fixture executable");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const pointer = { version: "2026.10.06", sha256, file: `yt-dlp-2026.10.06-${sha256}.exe` };
  const stage = ".yt-dlp-11111111-1111-4111-8111-111111111111.partial.exe";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-update-store-"));
    await mkdir(join(directory, "bin"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("rejects a tampered executable and malformed or oversized pointer without executing it", async () => {
    await writeFile(join(directory, "bin", pointer.file), contents);
    await activateUpdate(directory, pointer);
    expect(await readActiveUpdate(directory)).toBe(join(directory, "bin", pointer.file));
    await writeFile(join(directory, "bin", pointer.file), "tampered executable");
    expect(await readActiveUpdate(directory)).toBeUndefined();
    for (const value of [
      { ...pointer, file: "../outside.exe" },
      { ...pointer, extra: true },
      "x".repeat(3_000),
    ]) {
      await writeFile(join(directory, "bin/yt-dlp-active.json"), JSON.stringify(value));
      expect(await readActiveUpdate(directory)).toBeUndefined();
    }
  });
  it("never overwrites an existing immutable executable with different bytes", async () => {
    await writeFile(join(directory, "bin", stage), contents);
    await writeFile(join(directory, "bin", pointer.file), "foreign bytes");
    await expect(
      retainVerifiedExecutable(directory, stage, pointer, new AbortController().signal),
    ).rejects.toThrow("updateChecksumMismatch");
    expect(await readFile(join(directory, "bin", pointer.file), "utf8")).toBe("foreign bytes");
  });
  it("preserves the active pointer if activation is cancelled before its atomic rename", async () => {
    await writeFile(join(directory, "bin/yt-dlp-active.json"), "previous pointer");
    const controller = new AbortController();
    controller.abort();
    await expect(activateUpdate(directory, pointer, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(await readFile(join(directory, "bin/yt-dlp-active.json"), "utf8")).toBe(
      "previous pointer",
    );
  });
  it("refuses a junction directory rather than cleaning or writing through it", async () => {
    await rm(join(directory, "bin"), { recursive: true });
    const external = join(directory, "other");
    await mkdir(external);
    await writeFile(join(external, stage), "must survive");
    await symlink(
      external,
      join(directory, "bin"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(cleanupUpdateStages(directory)).rejects.toThrow("updateFailed");
    await expect(activateUpdate(directory, pointer)).rejects.toThrow("updateFailed");
    expect(await readFile(join(external, stage), "utf8")).toBe("must survive");
    expect(await readActiveUpdate(directory)).toBeUndefined();
  });
});
