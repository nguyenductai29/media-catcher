// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamMediaFile } from "./media-stream";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mv-stream-"));
  roots.push(root);
  const path = join(root, "clip.mp4");
  await writeFile(path, "0123456789");
  return path;
}
describe("bounded local media responses", () => {
  it("returns full and inclusive byte ranges with accurate media headers", async () => {
    const path = await fixture();
    const full = await streamMediaFile(path, null);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("10");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(await full.text()).toBe("0123456789");
    const partial = await streamMediaFile(path, "bytes=2-5");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(await partial.text()).toBe("2345");
    expect(await (await streamMediaFile(path, "bytes=-3")).text()).toBe("789");
    expect(await (await streamMediaFile(path, "bytes=7-")).text()).toBe("789");
  });
  it("rejects invalid, unsatisfiable, multi-range and empty ranges without a body", async () => {
    const path = await fixture();
    for (const range of [
      "bytes=10-",
      "bytes=8-2",
      "bytes=-0",
      "bytes=-",
      "bytes=0-1,4-5",
      "nonsense",
    ]) {
      const response = await streamMediaFile(path, range);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
      expect(await response.text()).toBe("");
    }
  });
  it("streams bounded chunks and permits cancellation without reading the full media", async () => {
    const path = await fixture();
    await writeFile(path, Buffer.alloc(1024 * 1024, 42));
    const response = await streamMediaFile(path, null);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(chunk.value!.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(chunk.done).toBe(false);
    await reader.cancel();
  });
});
