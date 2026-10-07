import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE downloads (
      id TEXT PRIMARY KEY NOT NULL,
      source_url TEXT NOT NULL, page_url TEXT, title TEXT NOT NULL, thumbnail TEXT,
      format_id TEXT, format_label TEXT, resolution TEXT,
      container TEXT NOT NULL CHECK(container IN ('mp4','mkv','original')),
      quality TEXT NOT NULL CHECK(quality IN ('best','selected','2160','1440','1080','720','480','audio')),
      destination_directory TEXT NOT NULL, output_path TEXT,
      media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
      downloaded_bytes INTEGER NOT NULL CHECK(downloaded_bytes >= 0),
      total_bytes INTEGER CHECK(total_bytes >= 0),
      progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 100),
      speed REAL CHECK(speed >= 0), eta REAL CHECK(eta >= 0),
      status TEXT NOT NULL CHECK(status IN ('queued','analyzing','downloading','processing','paused','completed','failed','cancelled')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, completed_at INTEGER, error TEXT,
      attempts INTEGER NOT NULL CHECK(attempts >= 0),
      from_analysis INTEGER NOT NULL CHECK(from_analysis IN (0,1))
    ) STRICT;
    CREATE INDEX downloads_status_created ON downloads(status, created_at DESC);
    CREATE TABLE media (
      id TEXT PRIMARY KEY NOT NULL,
      download_id TEXT REFERENCES downloads(id) ON DELETE SET NULL,
      title TEXT NOT NULL, source_url TEXT,
      source_type TEXT NOT NULL CHECK(source_type IN ('download','local')),
      local_path TEXT NOT NULL, normalized_path TEXT NOT NULL UNIQUE,
      thumbnail_path TEXT,
      duration REAL NOT NULL CHECK(duration >= 0),
      width INTEGER NOT NULL CHECK(width >= 0), height INTEGER NOT NULL CHECK(height >= 0),
      resolution TEXT NOT NULL, container TEXT NOT NULL,
      video_codec TEXT, audio_codec TEXT, bitrate REAL CHECK(bitrate >= 0),
      file_size INTEGER NOT NULL CHECK(file_size >= 0),
      modified_at REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX media_created ON media(created_at DESC);
    CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE activity_logs (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('downloadQueued','downloadStarted','downloadPaused','downloadResumed','downloadCancelled','downloadCompleted','downloadFailed','mediaAdded','mediaRemoved','fileDeleted')),
      title TEXT NOT NULL, created_at INTEGER NOT NULL,
      download_id TEXT, media_id TEXT, error TEXT
    ) STRICT;
    CREATE INDEX activity_created ON activity_logs(created_at DESC);
  `,
  },
];

/** All pending schema changes and the version update commit together. */
export function applyMigrations(
  database: Database.Database,
  steps: readonly Migration[] = migrations,
): void {
  try {
    if (!steps.length || steps.some((step, index) => step.version !== index + 1))
      throw new Error("invalid migrations");
    const current = database.pragma("user_version", { simple: true });
    if (typeof current !== "number" || current < 0 || current > steps.length)
      throw new Error("unsupported schema");
    database
      .transaction(() => {
        for (const step of steps) {
          if (step.version <= current) continue;
          database.exec(step.sql);
          // Versions come only from the validated, application-owned migration sequence.
          database.pragma(`user_version = ${step.version}`);
        }
      })
      .immediate();
  } catch (cause) {
    throw new Error("databaseFailed", { cause });
  }
}
