import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrations";

/** One main-process connection; prepared repositories carry metadata only. */
export class SqliteDatabase {
  private connection: Database.Database;

  constructor(userDataDirectory: string) {
    let connection: Database.Database | undefined;
    try {
      mkdirSync(userDataDirectory, { recursive: true });
      connection = new Database(join(userDataDirectory, "mediavault.db"));
      connection.pragma("foreign_keys = ON");
      connection.pragma("journal_mode = WAL");
      connection.pragma("synchronous = FULL");
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
