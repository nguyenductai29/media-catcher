// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "./database";
import { applyMigrations } from "./migrations";

describe("SQLite startup and migrations", () => {
  let directory: string;
  let database: SqliteDatabase | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-db-"));
  });
  afterEach(async () => {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates the database in userData, applies versioned tables once, and preserves existing data on reopen", () => {
    const userData = join(directory, "profile");
    database = new SqliteDatabase(userData);
    const inspector = new Database(join(userData, "mediavault.db"));
    expect(inspector.pragma("user_version", { simple: true })).toBe(1);
    expect(
      inspector.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    ).toEqual([
      { name: "activity_logs" },
      { name: "downloads" },
      { name: "media" },
      { name: "settings" },
    ]);
    inspector
      .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("sentinel", '"preserved"', 1);
    inspector.close();
    database.close();
    database = new SqliteDatabase(userData);
    const reopened = new Database(join(userData, "mediavault.db"), { readonly: true });
    expect(reopened.prepare("SELECT value_json FROM settings WHERE key=?").get("sentinel")).toEqual(
      { value_json: '"preserved"' },
    );
    reopened.close();
  });

  it("rolls back all pending DDL and data changes if a later migration fails", () => {
    const raw = new Database(join(directory, "rollback.db"));
    try {
      raw.exec(
        "CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('keep'); PRAGMA user_version=1;",
      );
      expect(() =>
        applyMigrations(raw, [
          { version: 1, sql: "CREATE TABLE existing (value TEXT)" },
          { version: 2, sql: "CREATE TABLE pending (value TEXT); DELETE FROM existing;" },
          { version: 3, sql: "INSERT INTO table_that_does_not_exist VALUES (1)" },
        ]),
      ).toThrow(/^databaseFailed$/);
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
      expect(raw.prepare("SELECT value FROM existing").get()).toEqual({ value: "keep" });
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE name='pending'").get(),
      ).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it("refuses a newer schema without downgrading or deleting it", () => {
    const raw = new Database(join(directory, "mediavault.db"));
    raw.exec(
      "PRAGMA user_version=99; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('preserve');",
    );
    raw.close();
    expect(() => new SqliteDatabase(directory)).toThrow(/^databaseFailed$/);
    const inspector = new Database(join(directory, "mediavault.db"));
    expect(inspector.pragma("user_version", { simple: true })).toBe(99);
    expect(inspector.prepare("SELECT * FROM future_data").get()).toEqual({ value: "preserve" });
    inspector.close();
  });

  it("reports unreadable or corrupt storage with a safe database error", async () => {
    await writeFile(join(directory, "mediavault.db"), "not a database; private detail");
    expect(() => new SqliteDatabase(directory)).toThrow(/^databaseFailed$/);
    const fileInsteadOfDirectory = join(directory, "not-a-directory");
    await writeFile(fileInsteadOfDirectory, "");
    expect(() => new SqliteDatabase(fileInsteadOfDirectory)).toThrow(/^databaseFailed$/);
  });

  it("rejects migration gaps before applying any changes", () => {
    const raw = new Database(":memory:");
    try {
      expect(() =>
        applyMigrations(raw, [{ version: 2, sql: "CREATE TABLE skipped(value TEXT)" }]),
      ).toThrow(/^databaseFailed$/);
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE name='skipped'").get(),
      ).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});
