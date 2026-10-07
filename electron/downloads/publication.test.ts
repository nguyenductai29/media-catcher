// @vitest-environment node
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  rename,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishRecoverably, recoverPublication, releasePublication } from "./publication";

const fault = vi.hoisted(() => ({
  work: "",
  crossVolume: true,
  afterLink: false,
  duringCopy: false,
  beforeCopying: false,
  beforeReady: false,
  preparingSeen: false,
  copyingSeen: false,
  maxWrite: 0,
  controller: undefined as AbortController | undefined,
}));
// Keep real file ownership/atomic links, injecting crashes at durable transitions.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    link: async (source: string, target: string) => {
      if (source.endsWith("source.mp4")) {
        if (fault.work) {
          const journal = JSON.parse(
            await fs.readFile(join(fault.work, "publication.json"), "utf8"),
          );
          fault.preparingSeen = journal.state === "preparing";
        }
        if (fault.crossVolume) throw Object.assign(new Error("cross-volume"), { code: "EXDEV" });
        await fs.link(source, target);
        if (fault.afterLink) throw new Error("simulated crash after hardlink");
        return;
      }
      return fs.link(source, target);
    },
    rename: async (source: string, target: string) => {
      if (fault.work && target === join(fault.work, "publication.json")) {
        const journal = JSON.parse(await fs.readFile(source, "utf8"));
        if (
          (fault.beforeCopying && journal.state === "copying") ||
          (fault.beforeReady && journal.state === "ready")
        )
          throw new Error("simulated crash before checkpoint");
      }
      return fs.rename(source, target);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (
        !fault.work ||
        !String(args[0]).endsWith(".pending") ||
        !String(args[0]).includes(".mediavault-")
      )
        return file;
      return new Proxy(file, {
        get(target, key) {
          if (key === "write")
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              const journal = JSON.parse(
                await fs.readFile(join(fault.work, "publication.json"), "utf8"),
              );
              fault.copyingSeen = journal.state === "copying";
              fault.maxWrite = Math.max(fault.maxWrite, length);
              const result = await target.write(buffer, offset, length, position);
              fault.controller?.abort();
              if (fault.duringCopy) throw new Error("simulated interrupted copy");
              return result;
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
const roots: string[] = [];
beforeEach(() =>
  Object.assign(fault, {
    work: "",
    crossVolume: true,
    afterLink: false,
    duringCopy: false,
    beforeCopying: false,
    beforeReady: false,
    preparingSeen: false,
    copyingSeen: false,
    maxWrite: 0,
    controller: undefined,
  }),
);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function crashFixture() {
  const root = await mkdtemp(join(tmpdir(), "mv-publication-crash-"));
  roots.push(root);
  const work = join(root, "work"),
    destination = join(root, "destination");
  await mkdir(work);
  await mkdir(destination);
  const source = join(work, "source.mp4");
  await writeFile(source, Buffer.alloc(200_000, 7));
  fault.work = work;
  return { root, work, destination, source };
}
it("records intent before a same-volume link and recovers a crash before the ready checkpoint", async () => {
  const f = await crashFixture();
  fault.crossVolume = false;
  fault.afterLink = true;
  await expect(
    publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work),
  ).rejects.toThrow();
  expect(fault.preparingSeen).toBe(true);
  const journal = JSON.parse(await readFile(join(f.work, "publication.json"), "utf8"));
  expect(journal.state).toBe("preparing");
  const actual = await stat(f.source, { bigint: true });
  expect(journal.source.ino).toBe(actual.ino.toString());
  expect(journal.source.dev).toBe(actual.dev.toString());
  expect(journal.source.modifiedAt).toBe(actual.mtimeNs.toString());
  fault.afterLink = false;
  const output = await recoverPublication(f.destination, "Movie", f.work);
  expect(output).toBe(join(f.destination, "Movie.mp4"));
  expect((await stat(output!)).size).toBe(200_000);
  await releasePublication(f.destination, f.work);
  expect(await readdir(f.destination)).toEqual(["Movie.mp4"]);
});
it.each(["duringCopy", "beforeReady"] as const)(
  "never publishes an interrupted %s and removes only its inode-owned stage",
  async (point) => {
    const f = await crashFixture();
    fault[point] = true;
    await writeFile(join(f.destination, "Existing.mp4"), "user media");
    await expect(
      publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work),
    ).rejects.toThrow();
    expect(fault.preparingSeen).toBe(true);
    expect(fault.copyingSeen).toBe(true);
    expect(fault.maxWrite).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(await readFile(join(f.work, "publication.json"), "utf8")).state).toBe(
      "copying",
    );
    expect(await recoverPublication(f.destination, "Movie", f.work)).toBeUndefined();
    expect(await readdir(f.destination)).toEqual(["Existing.mp4"]);
    expect(await readFile(join(f.destination, "Existing.mp4"), "utf8")).toBe("user media");
    fault[point] = false;
    expect(await publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work)).toBe(
      join(f.destination, "Movie.mp4"),
    );
  },
);
it("a crash before copying ownership is persisted can leave only an empty stage", async () => {
  const f = await crashFixture();
  fault.beforeCopying = true;
  await expect(
    publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work),
  ).rejects.toThrow();
  const entries = await readdir(f.destination);
  expect(entries).toHaveLength(1);
  expect((await stat(join(f.destination, entries[0]!))).size).toBe(0);
  expect(await recoverPublication(f.destination, "Movie", f.work)).toBeUndefined();
});
it("does not unlink a replaced partial-copy path", async () => {
  const f = await crashFixture();
  fault.duringCopy = true;
  await expect(
    publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work),
  ).rejects.toThrow();
  const stage = (await readdir(f.destination))[0]!;
  const replacement = join(f.destination, "replacement");
  await writeFile(replacement, "user-owned replacement");
  await rename(replacement, join(f.destination, stage));
  await expect(recoverPublication(f.destination, "Movie", f.work)).rejects.toThrow(/^fileChanged$/);
  expect(await readFile(join(f.destination, stage), "utf8")).toBe("user-owned replacement");
});
it("cancels a cross-volume copy between bounded writes and preserves the original source", async () => {
  const f = await crashFixture();
  fault.controller = new AbortController();
  await expect(
    publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work, fault.controller.signal),
  ).rejects.toThrow(/^cancelled$/);
  expect((await stat(f.source)).size).toBe(200_000);
  const stage = (await readdir(f.destination))[0]!;
  expect((await stat(join(f.destination, stage))).size).toBe(64 * 1024);
  expect(await recoverPublication(f.destination, "Movie", f.work)).toBeUndefined();
  expect(await readdir(f.destination)).toEqual([]);
  fault.controller = undefined;
  expect(await publishRecoverably(f.source, f.destination, "Movie", ".mp4", f.work)).toBe(
    join(f.destination, "Movie.mp4"),
  );
});
it("recovers publication after a cross-volume copy without duplicating or overwriting output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mv-publication-"));
  roots.push(root);
  const destination = join(root, "Downloads"),
    work = join(root, "work");
  await mkdir(destination);
  await mkdir(work);
  const source = join(work, "source.mp4");
  await writeFile(source, "generated fixture");
  await writeFile(join(destination, "Movie.mp4"), "existing user media");
  const first = await publishRecoverably(source, destination, "Movie", ".mp4", work);
  // Simulate crash after publication, before the DB output-path checkpoint.
  const resumed = await publishRecoverably(source, destination, "Movie", ".mp4", work);
  expect(resumed).toBe(first);
  expect(await recoverPublication(destination, "Movie", work)).toBe(first);
  expect(first).toBe(join(destination, "Movie (1).mp4"));
  await releasePublication(destination, work);
  expect((await readdir(destination)).sort()).toEqual(["Movie (1).mp4", "Movie.mp4"]);
  expect(await readFile(join(destination, "Movie.mp4"), "utf8")).toBe("existing user media");
});
it("refuses a replaced staging file instead of claiming unrelated bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mv-publication-"));
  roots.push(root);
  const work = join(root, "work");
  await mkdir(work);
  const source = join(work, "source.mp4");
  await writeFile(source, "fixture");
  await publishRecoverably(source, root, "Movie", ".mp4", work);
  const stage = (await readdir(root)).find((name) => name.endsWith(".pending"))!;
  await copyFile(source, join(root, "replacement"));
  await writeFile(join(root, stage), "unrelated changed bytes");
  await expect(publishRecoverably(source, root, "Movie", ".mp4", work)).rejects.toThrow(
    "fileChanged",
  );
});
