import type { DownloadJob } from "../../shared/models";
import type { SqliteDatabase } from "../database/database";

interface DownloadRow {
  id: string;
  source_url: string;
  page_url: string | null;
  title: string;
  thumbnail: string | null;
  format_id: string | null;
  format_label: string | null;
  resolution: string | null;
  container: DownloadJob["container"];
  quality: DownloadJob["quality"];
  destination_directory: string;
  output_path: string | null;
  media_id: string | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  progress: number;
  speed: number | null;
  eta: number | null;
  status: DownloadJob["status"];
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: NonNullable<DownloadJob["error"]> | null;
  attempts: number;
  from_analysis: number;
  requires_browser_session: number;
}
const columns = `id, source_url, page_url, title, thumbnail, format_id, format_label, resolution,
  container, quality, destination_directory, output_path, media_id, downloaded_bytes, total_bytes,
  progress, speed, eta, status, created_at, updated_at, started_at, completed_at, error, attempts, from_analysis, requires_browser_session`;
// Identifiers are application-owned constants; all values use named bindings.
const names = columns.split(",").map((name) => name.trim());
const upsert = `INSERT INTO downloads (${columns}) VALUES (${names.map((name) => `@${name}`).join(", ")})
  ON CONFLICT(id) DO UPDATE SET ${names
    .filter((name) => name !== "id")
    .map((name) => `${name}=excluded.${name}`)
    .join(", ")}`;

function encode(job: DownloadJob): DownloadRow {
  return {
    id: job.id,
    source_url: job.sourceUrl,
    page_url: job.pageUrl ?? null,
    title: job.title,
    thumbnail: job.thumbnail ?? null,
    format_id: job.formatId ?? null,
    format_label: job.formatLabel ?? null,
    resolution: job.resolution ?? null,
    container: job.container,
    quality: job.quality,
    destination_directory: job.destinationDirectory,
    output_path: job.outputPath ?? null,
    media_id: job.mediaId ?? null,
    downloaded_bytes: job.downloadedBytes,
    total_bytes: job.totalBytes ?? null,
    progress: job.progress,
    speed: job.speed ?? null,
    eta: job.eta ?? null,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    error: job.error ?? null,
    attempts: job.attempts,
    from_analysis: job.fromAnalysis ? 1 : 0,
    requires_browser_session: job.requiresBrowserSession ? 1 : 0,
  };
}
function decode(row: DownloadRow): DownloadJob {
  const job: DownloadJob = {
    id: row.id,
    sourceUrl: row.source_url,
    title: row.title,
    container: row.container,
    quality: row.quality,
    destinationDirectory: row.destination_directory,
    downloadedBytes: row.downloaded_bytes,
    progress: row.progress,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts: row.attempts,
    fromAnalysis: row.from_analysis === 1,
  };
  if (row.page_url !== null) job.pageUrl = row.page_url;
  if (row.thumbnail !== null) job.thumbnail = row.thumbnail;
  if (row.format_id !== null) job.formatId = row.format_id;
  if (row.format_label !== null) job.formatLabel = row.format_label;
  if (row.resolution !== null) job.resolution = row.resolution;
  if (row.output_path !== null) job.outputPath = row.output_path;
  if (row.media_id !== null) job.mediaId = row.media_id;
  if (row.total_bytes !== null) job.totalBytes = row.total_bytes;
  if (row.speed !== null) job.speed = row.speed;
  if (row.eta !== null) job.eta = row.eta;
  if (row.started_at !== null) job.startedAt = row.started_at;
  if (row.completed_at !== null) job.completedAt = row.completed_at;
  if (row.error !== null) job.error = row.error;
  if (row.requires_browser_session === 1) job.requiresBrowserSession = true;
  return job;
}

export class DownloadRepository {
  constructor(private database: SqliteDatabase) {}

  list(): DownloadJob[] {
    return this.database.query((connection) =>
      connection
        .prepare<[], DownloadRow>(
          `SELECT ${columns} FROM downloads ORDER BY created_at DESC, id DESC`,
        )
        .all()
        .map(decode),
    );
  }

  get(id: string): DownloadJob | undefined {
    return this.database.query((connection) => {
      const row = connection
        .prepare<[string], DownloadRow>(`SELECT ${columns} FROM downloads WHERE id = ?`)
        .get(id);
      return row ? decode(row) : undefined;
    });
  }

  save(job: DownloadJob): DownloadJob {
    this.database.query((connection) => connection.prepare<DownloadRow>(upsert).run(encode(job)));
    return job;
  }

  deleteCompleted(): number {
    return this.database.query(
      (connection) =>
        connection.prepare("DELETE FROM downloads WHERE status = 'completed'").run().changes,
    );
  }

  recoverInterrupted(now = Date.now()): number {
    return this.database.query(
      (connection) =>
        connection
          .prepare(
            `UPDATE downloads
      SET status = 'paused', speed = NULL, eta = NULL, updated_at = ?
      WHERE status IN ('queued', 'analyzing', 'downloading', 'processing')`,
          )
          .run(now).changes,
    );
  }
}
