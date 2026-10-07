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
  {
    version: 2,
    sql: `
    ALTER TABLE media ADD COLUMN local_available INTEGER NOT NULL DEFAULT 1 CHECK(local_available IN (0,1));
    ALTER TABLE media ADD COLUMN drive_file_id TEXT;
    ALTER TABLE media ADD COLUMN drive_account_id TEXT;
    ALTER TABLE media ADD COLUMN drive_uploaded_at INTEGER;
    ALTER TABLE media ADD COLUMN drive_status TEXT CHECK(drive_status IN ('queued','preparing','uploading','paused','finalizing','completed','failed','cancelled','missing','changed'));
    ALTER TABLE media ADD COLUMN drive_available INTEGER NOT NULL DEFAULT 0 CHECK(drive_available IN (0,1));
    CREATE INDEX media_drive_account_file ON media(drive_account_id, drive_file_id);
    CREATE TABLE drive_uploads (
      id TEXT PRIMARY KEY NOT NULL,
      media_id TEXT NOT NULL, provider_account_id TEXT NOT NULL,
      local_path TEXT NOT NULL, modified_at REAL NOT NULL,
      file_name TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size >= 0), mime_type TEXT NOT NULL,
      drive_folder_id TEXT, drive_file_id TEXT, planned_file_id TEXT,
      uploaded_bytes INTEGER NOT NULL CHECK(uploaded_bytes >= 0 AND uploaded_bytes <= file_size),
      progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 100),
      speed REAL CHECK(speed >= 0), eta REAL CHECK(eta >= 0),
      status TEXT NOT NULL CHECK(status IN ('queued','preparing','uploading','paused','finalizing','completed','failed','cancelled')),
      session_encrypted TEXT, error TEXT,
      attempts INTEGER NOT NULL CHECK(attempts >= 0),
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX drive_uploads_status_created ON drive_uploads(status, created_at DESC);
    CREATE INDEX drive_uploads_media_account ON drive_uploads(media_id, provider_account_id);
    CREATE UNIQUE INDEX drive_uploads_one_unfinished ON drive_uploads(media_id, provider_account_id)
      WHERE status IN ('queued','preparing','uploading','paused','finalizing','failed');
    CREATE TABLE activity_logs_v2 (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('downloadQueued','downloadStarted','downloadPaused','downloadResumed','downloadCancelled','downloadCompleted','downloadFailed','mediaAdded','mediaRemoved','fileDeleted','driveConnected','driveDisconnected','driveUploadQueued','driveUploadStarted','driveUploadPaused','driveUploadResumed','driveUploadCompleted','driveUploadFailed','driveUploadCancelled','localFileDeletedAfterUpload')),
      title TEXT NOT NULL, created_at INTEGER NOT NULL,
      download_id TEXT, media_id TEXT, error TEXT
    ) STRICT;
    INSERT INTO activity_logs_v2(id,type,title,created_at,download_id,media_id,error)
      SELECT id,type,title,created_at,download_id,media_id,error FROM activity_logs;
    DROP TABLE activity_logs;
    ALTER TABLE activity_logs_v2 RENAME TO activity_logs;
    CREATE INDEX activity_created ON activity_logs(created_at DESC);
  `,
  },
  {
    version: 3,
    sql: `
    ALTER TABLE downloads ADD COLUMN requires_browser_session INTEGER NOT NULL DEFAULT 0 CHECK(requires_browser_session IN (0,1));
    ALTER TABLE media ADD COLUMN content_fingerprint TEXT;
    CREATE INDEX media_content_fingerprint ON media(file_size, content_fingerprint) WHERE local_available = 1;
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
