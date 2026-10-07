import { resolve } from "node:path";
import type { MediaItem } from "../../shared/models";
import type { SqliteDatabase } from "../database/database";

interface MediaRow {
  id: string;
  download_id: string | null;
  title: string;
  source_url: string | null;
  source_type: MediaItem["sourceType"];
  local_path: string;
  normalized_path: string;
  thumbnail_path: string | null;
  duration: number;
  width: number;
  height: number;
  resolution: string;
  container: string;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  file_size: number;
  modified_at: number;
  created_at: number;
  updated_at: number;
}
const columns = `id, download_id, title, source_url, source_type, local_path, normalized_path,
  thumbnail_path, duration, width, height, resolution, container, video_codec, audio_codec,
  bitrate, file_size, modified_at, created_at, updated_at`;
const names = columns.split(",").map((name) => name.trim());
const upsert = `INSERT INTO media (${columns}) VALUES (${names.map((name) => `@${name}`).join(", ")})
  ON CONFLICT(id) DO UPDATE SET ${names
    .filter((name) => name !== "id")
    .map((name) => `${name}=excluded.${name}`)
    .join(", ")}`;

/** The LibraryService resolves symlinks first; this handles lexical/case aliases. */
function pathKey(localPath: string): string {
  const absolute = resolve(localPath);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function encode(item: MediaItem): MediaRow {
  return {
    id: item.id,
    download_id: item.downloadId ?? null,
    title: item.title,
    source_url: item.sourceUrl ?? null,
    source_type: item.sourceType,
    local_path: item.localPath,
    normalized_path: pathKey(item.localPath),
    thumbnail_path: item.thumbnailPath ?? null,
    duration: item.duration,
    width: item.width,
    height: item.height,
    resolution: item.resolution,
    container: item.container,
    video_codec: item.videoCodec ?? null,
    audio_codec: item.audioCodec ?? null,
    bitrate: item.bitrate ?? null,
    file_size: item.fileSize,
    modified_at: item.modifiedAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}
function decode(row: MediaRow): MediaItem {
  const item: MediaItem = {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    localPath: row.local_path,
    duration: row.duration,
    width: row.width,
    height: row.height,
    resolution: row.resolution,
    container: row.container,
    fileSize: row.file_size,
    modifiedAt: row.modified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.download_id !== null) item.downloadId = row.download_id;
  if (row.source_url !== null) item.sourceUrl = row.source_url;
  if (row.thumbnail_path !== null) item.thumbnailPath = row.thumbnail_path;
  if (row.video_codec !== null) item.videoCodec = row.video_codec;
  if (row.audio_codec !== null) item.audioCodec = row.audio_codec;
  if (row.bitrate !== null) item.bitrate = row.bitrate;
  return item;
}

export class MediaRepository {
  constructor(private database: SqliteDatabase) {}

  list(): MediaItem[] {
    return this.database.query((connection) =>
      connection
        .prepare<[], MediaRow>(`SELECT ${columns} FROM media ORDER BY created_at DESC, id DESC`)
        .all()
        .map(decode),
    );
  }

  get(id: string): MediaItem | undefined {
    return this.database.query((connection) => {
      const row = connection
        .prepare<[string], MediaRow>(`SELECT ${columns} FROM media WHERE id = ?`)
        .get(id);
      return row ? decode(row) : undefined;
    });
  }

  getByPath(localPath: string): MediaItem | undefined {
    return this.database.query((connection) => {
      const row = connection
        .prepare<[string], MediaRow>(`SELECT ${columns} FROM media WHERE normalized_path = ?`)
        .get(pathKey(localPath));
      return row ? decode(row) : undefined;
    });
  }

  save(item: MediaItem): MediaItem {
    this.database.query((connection) => connection.prepare<MediaRow>(upsert).run(encode(item)));
    return item;
  }

  remove(id: string): boolean {
    return this.database.query(
      (connection) => connection.prepare("DELETE FROM media WHERE id = ?").run(id).changes > 0,
    );
  }
}
