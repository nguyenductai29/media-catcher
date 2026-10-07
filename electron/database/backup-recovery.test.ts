// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "./database";
import { applyMigrations, migrations } from "./migrations";
import { createDatabaseBackup, listDatabaseBackups } from "./backups";
import { openDatabaseWithRecovery } from "./open-database";

describe("consistent backups and explicit recovery", () => {
  let directory: string;
  const connections: Array<Database.Database | SqliteDatabase> = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mv-recovery-"));
  });
  afterEach(async () => {
    for (const db of connections.splice(0)) {
      if (db instanceof SqliteDatabase || db.open) db.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  function legacy() {
    const db = new Database(join(directory, "mediavault.db"));
    connections.push(db);
    db.pragma("journal_mode=WAL");
    applyMigrations(db, migrations.slice(0, 2));
    db.prepare("INSERT INTO settings VALUES(?,?,?)").run("sentinel", '"keep"', 1);
    return db;
  }
  it("backs up committed WAL data before changing a populated schema", () => {
    const old = legacy();
    const current = new SqliteDatabase(directory);
    connections.push(current);
    expect(current.query((db) => db.pragma("user_version", { simple: true }))).toBe(
      migrations.length,
    );
    const backups = listDatabaseBackups(directory);
    expect(backups).toHaveLength(1);
    const copy = new Database(backups[0]!, { readonly: true });
    try {
      expect(copy.pragma("user_version", { simple: true })).toBe(2);
      expect(copy.prepare("SELECT value_json FROM settings WHERE key='sentinel'").get()).toEqual({
        value_json: '"keep"',
      });
    } finally {
      copy.close();
    }
    old.close();
    current.close();
    connections.push(new SqliteDatabase(directory));
    expect(listDatabaseBackups(directory)).toEqual(backups);
  });
  it("keeps the newest three validated snapshots without counting corrupt or unrelated files", async () => {
    const db = legacy();
    await mkdir(join(directory, "backups"));
    await writeFile(join(directory, "backups", "personal.db"), "user file");
    const paths: string[] = [];
    for (let n = 0; n < 5; n++) {
      db.prepare("UPDATE settings SET value_json=?").run(JSON.stringify(n));
      paths.push(createDatabaseBackup(db, directory));
    }
    expect(listDatabaseBackups(directory)).toEqual(paths.slice(-3).reverse());
    expect(await readFile(join(directory, "backups", "personal.db"), "utf8")).toBe("user file");
    for (const path of paths.slice(0, 2))
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not migrate when the required backup cannot be created", async () => {
    const db = legacy();
    db.close();
    await writeFile(join(directory, "backups"), "blocked");
    expect(() => new SqliteDatabase(directory)).toThrow("databaseFailed");
    const check = new Database(join(directory, "mediavault.db"));
    connections.push(check);
    expect(check.pragma("user_version", { simple: true })).toBe(2);
    expect(check.prepare("SELECT value_json FROM settings").get()).toEqual({
      value_json: '"keep"',
    });
  });
  it("preserves corruption unchanged when the native user opens the data folder and exits", async () => {
    const path = join(directory, "mediavault.db");
    await writeFile(path, "corrupt original");
    const choose = vi.fn().mockResolvedValueOnce("openFolder").mockResolvedValueOnce("exit");
    const openDataFolder = vi.fn().mockResolvedValue(undefined);
    expect(await openDatabaseWithRecovery(directory, { choose, openDataFolder })).toBeNull();
    expect(choose).toHaveBeenCalledWith({ canRestore: false });
    expect(openDataFolder).toHaveBeenCalledWith(directory);
    expect(await readFile(path, "utf8")).toBe("corrupt original");
    expect(await readdir(directory)).toEqual(["mediavault.db"]);
  });
  it("restores only after explicit selection and quarantines the original database and sidecars", async () => {
    const db = legacy();
    createDatabaseBackup(db, directory);
    db.close();
    await writeFile(join(directory, "mediavault.db"), "broken database");
    await writeFile(join(directory, "mediavault.db-wal"), "old wal");
    await writeFile(join(directory, "mediavault.db-shm"), "old shm");
    const choose = vi.fn().mockResolvedValue("restore");
    const recovered = await openDatabaseWithRecovery(directory, {
      choose,
      openDataFolder: async () => {},
    });
    expect(choose).toHaveBeenCalledExactlyOnceWith({ canRestore: true });
    expect(recovered).not.toBeNull();
    if (recovered) connections.push(recovered);
    expect(
      recovered?.query((connection) =>
        connection.prepare("SELECT value_json FROM settings WHERE key='sentinel'").get(),
      ),
    ).toEqual({ value_json: '"keep"' });
    const [quarantine] = await readdir(join(directory, "quarantine"));
    expect(quarantine).toBeDefined();
    const quarantined = join(directory, "quarantine", quarantine!);
    expect(await readFile(join(quarantined, "mediavault.db"), "utf8")).toBe("broken database");
    expect(await readFile(join(quarantined, "mediavault.db-wal"), "utf8")).toBe("old wal");
    expect(await readFile(join(quarantined, "mediavault.db-shm"), "utf8")).toBe("old shm");
  });
  it("ignores corrupt backup candidates and never creates an empty replacement on unavailable restore", async () => {
    await mkdir(join(directory, "backups"));
    await writeFile(
      join(
        directory,
        "backups",
        "mediavault-v2-0000000000001-00000000-0000-4000-8000-000000000000.db",
      ),
      "broken backup",
    );
    await writeFile(join(directory, "mediavault.db"), "original");
    const choose = vi.fn().mockResolvedValueOnce("restore").mockResolvedValueOnce("exit");
    expect(
      await openDatabaseWithRecovery(directory, { choose, openDataFolder: async () => {} }),
    ).toBeNull();
    expect(choose).toHaveBeenNthCalledWith(1, { canRestore: false });
    expect(await readFile(join(directory, "mediavault.db"), "utf8")).toBe("original");
  });
  it("treats an existing empty database as damaged storage instead of silently initializing it", async () => {
    const path = join(directory, "mediavault.db");
    await writeFile(path, "");
    const choose = vi.fn().mockResolvedValue("exit");
    expect(
      await openDatabaseWithRecovery(directory, { choose, openDataFolder: async () => {} }),
    ).toBeNull();
    expect(choose).toHaveBeenCalledExactlyOnceWith({ canRestore: false });
    expect((await readFile(path)).length).toBe(0);
  });
  it("does not initialize a missing database over leftover recovery sidecars", async () => {
    await writeFile(join(directory, "mediavault.db-wal"), "recoverable evidence");
    const choose = vi.fn().mockResolvedValue("exit");
    const opened = await openDatabaseWithRecovery(directory, {
      choose,
      openDataFolder: async () => {},
    });
    if (opened) connections.push(opened);
    expect(opened).toBeNull();
    expect(await readdir(directory)).toEqual(["mediavault.db-wal"]);
  });
  it("refuses redirected backup folders without writing to the external directory", async () => {
    const db = legacy();
    const external = join(directory, "external");
    await mkdir(external);
    await symlink(external, join(directory, "backups"), "junction");
    expect(() => createDatabaseBackup(db, directory)).toThrow("databaseFailed");
    expect(await readdir(external)).toEqual([]);
    expect(listDatabaseBackups(directory)).toEqual([]);
  });
});
