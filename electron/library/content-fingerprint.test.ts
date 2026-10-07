// @vitest-environment node
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { contentFingerprint } from "./content-fingerprint";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("matches copies and detects changed sampled content", async () => {
  const root = await mkdtemp(join(tmpdir(), "mv-fingerprint-"));
  roots.push(root);
  const a = join(root, "a.mp4"),
    b = join(root, "b.mp4");
  await writeFile(a, Buffer.alloc(8 * 1024 * 1024, 42));
  await writeFile(b, Buffer.alloc(8 * 1024 * 1024, 42));
  expect(await contentFingerprint(a)).toBe(await contentFingerprint(b));
  const file = await open(b, "r+");
  try {
    await file.write(Buffer.from([1]), 0, 1, 4 * 1024 * 1024);
  } finally {
    await file.close();
  }
  expect(await contentFingerprint(a)).not.toBe(await contentFingerprint(b));
});
it("rejects cancellation before reading and handles files smaller than one sample", async () => {
  const root = await mkdtemp(join(tmpdir(), "mv-fingerprint-"));
  roots.push(root);
  const path = join(root, "small.mp4");
  await writeFile(path, "fixture");
  expect(await contentFingerprint(path)).toMatch(/^sample-v1:7:[a-f0-9]{64}$/);
  await expect(contentFingerprint(path, AbortSignal.abort())).rejects.toThrow("cancelled");
});
