import type { StoredDriveUpload } from "../drive/models";
import type { SqliteDatabase } from "../database/database";

interface UploadRow {
  id: string;
  media_id: string;
  provider_account_id: string;
  local_path: string;
  modified_at: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  drive_folder_id: string | null;
  drive_file_id: string | null;
  planned_file_id: string | null;
  uploaded_bytes: number;
  progress: number;
  speed: number | null;
  eta: number | null;
  status: StoredDriveUpload["status"];
  session_encrypted: string | null;
  error: NonNullable<StoredDriveUpload["error"]> | null;
  attempts: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}
const columns = `id, media_id, provider_account_id, local_path, modified_at, file_name, file_size, mime_type,
  drive_folder_id, drive_file_id, planned_file_id, uploaded_bytes, progress, speed, eta, status,
  session_encrypted, error, attempts, created_at, started_at, completed_at, updated_at`;
const names = columns.split(",").map((name) => name.trim());
const unfinished = "'queued','preparing','uploading','paused','finalizing','failed'";
const upsert = `INSERT INTO drive_uploads (${columns}) VALUES (${names.map((name) => `@${name}`).join(", ")})
  ON CONFLICT(id) DO UPDATE SET ${names
    .filter((name) => name !== "id")
    .map((name) => `${name}=excluded.${name}`)
    .join(", ")}`;
function encode(job: StoredDriveUpload): UploadRow {
  return {
    id: job.id,
    media_id: job.mediaId,
    provider_account_id: job.providerAccountId,
    local_path: job.localPath,
    modified_at: job.modifiedAt,
    file_name: job.fileName,
    file_size: job.fileSize,
    mime_type: job.mimeType,
    drive_folder_id: job.driveFolderId ?? null,
    drive_file_id: job.driveFileId ?? null,
    planned_file_id: job.plannedFileId ?? null,
    uploaded_bytes: job.uploadedBytes,
    progress: job.progress,
    speed: job.speed ?? null,
    eta: job.eta ?? null,
    status: job.status,
    session_encrypted: job.sessionEncrypted ?? null,
    error: job.error ?? null,
    attempts: job.attempts,
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    updated_at: job.updatedAt,
  };
}
function decode(row: UploadRow): StoredDriveUpload {
  const job: StoredDriveUpload = {
    id: row.id,
    mediaId: row.media_id,
    providerAccountId: row.provider_account_id,
    localPath: row.local_path,
    modifiedAt: row.modified_at,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    uploadedBytes: row.uploaded_bytes,
    progress: row.progress,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.drive_folder_id !== null) job.driveFolderId = row.drive_folder_id;
  if (row.drive_file_id !== null) job.driveFileId = row.drive_file_id;
  if (row.planned_file_id !== null) job.plannedFileId = row.planned_file_id;
  if (row.session_encrypted !== null) job.sessionEncrypted = row.session_encrypted;
  if (row.speed !== null) job.speed = row.speed;
  if (row.eta !== null) job.eta = row.eta;
  if (row.error !== null) job.error = row.error;
  if (row.started_at !== null) job.startedAt = row.started_at;
  if (row.completed_at !== null) job.completedAt = row.completed_at;
  return job;
}

/** Main-only metadata. Call uploadDTO before emitting any row to a renderer. */
export class DriveUploadRepository {
  constructor(private readonly database: SqliteDatabase) {}
  list(): StoredDriveUpload[] {
    return this.database.query((db) =>
      db
        .prepare<[], UploadRow>(
          `SELECT ${columns} FROM drive_uploads ORDER BY created_at DESC, id DESC`,
        )
        .all()
        .map(decode),
    );
  }
  get(id: string): StoredDriveUpload | undefined {
    return this.database.query((db) => {
      const row = db
        .prepare<[string], UploadRow>(`SELECT ${columns} FROM drive_uploads WHERE id = ?`)
        .get(id);
      return row ? decode(row) : undefined;
    });
  }
  save(job: StoredDriveUpload): StoredDriveUpload {
    this.database.query((db) => db.prepare<UploadRow>(upsert).run(encode(job)));
    return job;
  }
  findActive(mediaId: string, providerAccountId: string): StoredDriveUpload | undefined {
    return this.database.query((db) => {
      const row = db
        .prepare<[string, string], UploadRow>(
          `SELECT ${columns} FROM drive_uploads WHERE media_id = ? AND provider_account_id = ? AND status IN (${unfinished})`,
        )
        .get(mediaId, providerAccountId);
      return row ? decode(row) : undefined;
    });
  }
  listRecoverable(): StoredDriveUpload[] {
    return this.database.query((db) =>
      db
        .prepare<[], UploadRow>(
          `SELECT ${columns} FROM drive_uploads WHERE status IN (${unfinished}) ORDER BY created_at, id`,
        )
        .all()
        .map(decode),
    );
  }
  recoverInterrupted(now = Date.now()): number {
    return this.database.query(
      (db) =>
        db
          .prepare(
            `UPDATE drive_uploads SET status='paused', speed=NULL, eta=NULL, updated_at=? WHERE status IN ('queued','preparing','uploading')`,
          )
          .run(now).changes,
    );
  }
  deleteCompleted(): number {
    return this.database.query(
      (db) => db.prepare("DELETE FROM drive_uploads WHERE status='completed'").run().changes,
    );
  }
  removeForMedia(mediaId: string): number {
    return this.database.query(
      (db) => db.prepare("DELETE FROM drive_uploads WHERE media_id=?").run(mediaId).changes,
    );
  }
}
