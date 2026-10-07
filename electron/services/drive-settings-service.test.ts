// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database/database";
import { SettingsRepository } from "../repositories/settings-repository";
import { DriveSettingsService } from "./drive-settings-service";

describe("Drive settings", () => {
  let directory: string,
    db: SqliteDatabase,
    repository: SettingsRepository,
    service: DriveSettingsService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-drive-settings-"));
    db = new SqliteDatabase(directory);
    repository = new SettingsRepository(db);
    service = new DriveSettingsService(repository);
  });
  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("defaults to no automatic upload or deletion and moderate concurrency/chunk size", () => {
    expect(service.get()).toEqual({
      concurrency: 2,
      autoUpload: false,
      deleteLocal: "never",
      chunkSizeMiB: 8,
    });
  });
  it("persists validated preferences in the existing settings table across restart", () => {
    const next = {
      concurrency: 3,
      autoUpload: true,
      deleteLocal: "ask" as const,
      chunkSizeMiB: 16,
    };
    expect(service.update(next)).toEqual(next);
    db.close();
    db = new SqliteDatabase(directory);
    service = new DriveSettingsService(new SettingsRepository(db));
    expect(service.get()).toEqual(next);
    const copy = service.get();
    copy.autoUpload = false;
    expect(service.get().autoUpload).toBe(true);
  });
  it.each([
    { concurrency: 0 },
    { concurrency: 4 },
    { concurrency: 1.5 },
    { autoUpload: "true" },
    { deleteLocal: "always" },
    { chunkSizeMiB: 0 },
    { chunkSizeMiB: 65 },
    { chunkSizeMiB: 1.5 },
    { token: "sensitive" },
  ])(
    "rejects invalid or unrecognized preference %j without changing persisted settings",
    (invalid) => {
      const initial = service.get();
      expect(() => service.update({ ...initial, ...invalid })).toThrow(/^invalidInput$/);
      expect(service.get()).toEqual(initial);
      expect(new DriveSettingsService(repository).get()).toEqual(initial);
    },
  );
  it("does not change memory state if database persistence fails", () => {
    const initial = service.get();
    db.close();
    expect(() => service.update({ ...initial, autoUpload: true })).toThrow(/^databaseFailed$/);
    expect(service.get()).toEqual(initial);
  });
});
