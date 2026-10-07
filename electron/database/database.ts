import { closeSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations, migrations } from "./migrations";
import { createDatabaseBackup } from "./backups";

/** One main-process connection; prepared repositories carry metadata only. */
export class SqliteDatabase {
  private connection: Database.Database;

  constructor(userDataDirectory: string) {
    let connection: Database.Database | undefined;
    try {
      mkdirSync(userDataDirectory, { recursive: true });
      const path = join(userDataDirectory, "mediavault.db");
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        throw new Error("databaseFailed");
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
        if (sidecar && (!existing || !sidecar.isFile() || sidecar.isSymbolicLink()))
          throw new Error("databaseFailed");
      }
      // A writable SQLite open can discard damaged sidecars on close. Diagnose
      // existing storage read-only first so recovery keeps the original evidence.
      if (existing) {
        const descriptor = openSync(path, "r");
        try {
          const header = Buffer.alloc(16);
          const length = readSync(descriptor, header, 0, header.length, 0);
          if (length !== 16 || header.toString("ascii") !== "SQLite format 3\0")
            throw new Error("databaseFailed");
        } finally {
          closeSync(descriptor);
        }
        const inspection = new Database(path, { readonly: true, fileMustExist: true });
        try {
          if (inspection.pragma("quick_check", { simple: true }) !== "ok")
            throw new Error("databaseFailed");
          const version = inspection.pragma("user_version", { simple: true });
          if (typeof version !== "number" || version < 0 || version > migrations.length)
            throw new Error("databaseFailed");
        } finally {
          inspection.close();
        }
      }
      connection = new Database(path);
      if (connection.pragma("quick_check", { simple: true }) !== "ok")
        throw new Error("databaseFailed");
      const version = connection.pragma("user_version", { simple: true });
      if (typeof version !== "number" || version < 0 || version > migrations.length)
        throw new Error("databaseFailed");
      connection.pragma("foreign_keys = ON");
      connection.pragma("journal_mode = WAL");
      connection.pragma("synchronous = FULL");
      if (version > 0 && version < migrations.length)
        createDatabaseBackup(connection, userDataDirectory);
      applyMigrations(connection);
      this.connection = connection;
    } catch (cause) {
      connection?.close();
      throw new Error("databaseFailed", { cause });
    }
  }

  /** Central error boundary prevents SQL diagnostics leaking into IPC. */
  query<T>(operation: (connection: Database.Database) => T): T {
    try {
      return operation(this.connection);
    } catch (cause) {
      throw new Error("databaseFailed", { cause });
    }
  }

  /** Callbacks must be synchronous; better-sqlite3 rejects Promise results. */
  transaction<T>(operation: () => T): T {
    return this.query((connection) => connection.transaction(operation).immediate());
  }

  close(): void {
    if (this.connection.open)
      this.query((connection) => {
        connection.close();
      });
  }
}
