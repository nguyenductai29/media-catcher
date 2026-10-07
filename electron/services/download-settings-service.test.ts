// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDatabase } from "../database/database";
import { SettingsRepository } from "../repositories/settings-repository";
import { DownloadSettingsService } from "./download-settings-service";

const roots: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "mv-settings-"));
  roots.push(root);
  const db = new SqliteDatabase(join(root, "data"));
  databases.push(db);
  const repo = new SettingsRepository(db);
  return { root, repo, service: new DownloadSettingsService(repo, join(root, "Videos")) };
}
describe("persisted download preferences", () => {
  it("uses concurrency two and lazily configured video directories", async () => {
    const { root, service } = await setup();
    expect(service.get()).toEqual({
      directory: join(root, "Videos", "MediaVault", "Downloads"),
      concurrency: 2,
      quality: "best",
      container: "mp4",
      autoRetry: false,
    });
  });
  it("persists an approved native directory and rejects arbitrary renderer paths", async () => {
    const { root, repo, service } = await setup();
    const chosen = join(root, "picked");
    await mkdir(chosen);
    await expect(service.update({ ...service.get(), directory: chosen })).rejects.toThrow(
      "invalidInput",
    );
    const approved = await service.approveDirectory(chosen);
    await service.update({ ...service.get(), directory: approved, concurrency: 5, quality: "720" });
    const restored = new DownloadSettingsService(repo, join(root, "Videos"));
    expect(restored.get()).toEqual(service.get());
    await expect(restored.validateDirectory(approved)).resolves.toBe(approved);
  });
  it("rejects malformed preferences without changing the saved record", async () => {
    const { service } = await setup();
    for (const patch of [
      { concurrency: 0 },
      { concurrency: 6 },
      { concurrency: 1.1 },
      { autoRetry: "yes" },
      { quality: "4k" },
      { injected: "x" },
    ]) {
      await expect(service.update({ ...service.get(), ...patch })).rejects.toThrow("invalidInput");
    }
    expect(service.get().concurrency).toBe(2);
  });
  it("rejects selected directories inside app resources including dot-prefixed children", async () => {
    const { root, repo } = await setup();
    const protectedRoot = join(root, "resources");
    const service = new DownloadSettingsService(repo, root, [protectedRoot]);
    for (const name of ["bin", "..cache"]) {
      const directory = join(protectedRoot, name);
      await mkdir(directory, { recursive: true });
      await expect(service.approveDirectory(directory)).rejects.toThrow("invalidInput");
    }
  });
});
