import type { SqliteDatabase } from "../database/database";

export class SettingsRepository {
  constructor(private database: SqliteDatabase) {}

  get<T>(key: string): T | undefined {
    return this.database.query((connection) => {
      const row = connection
        .prepare<[string], { value_json: string }>("SELECT value_json FROM settings WHERE key = ?")
        .get(key);
      return row ? (JSON.parse(row.value_json) as T) : undefined;
    });
  }

  set(key: string, value: unknown): void {
    this.database.query((connection) => {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error("non-serializable setting");
      connection
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(key, json, Date.now());
    });
  }
}
