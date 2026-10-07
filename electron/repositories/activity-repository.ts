import type { ActivityItem } from "../../shared/models";
import type { SqliteDatabase } from "../database/database";

interface ActivityRow {
  id: string;
  type: ActivityItem["type"];
  title: string;
  created_at: number;
  download_id: string | null;
  media_id: string | null;
  error: NonNullable<ActivityItem["error"]> | null;
}
function decode(row: ActivityRow): ActivityItem {
  const item: ActivityItem = {
    id: row.id,
    type: row.type,
    title: row.title,
    createdAt: row.created_at,
  };
  if (row.download_id !== null) item.downloadId = row.download_id;
  if (row.media_id !== null) item.mediaId = row.media_id;
  if (row.error !== null) item.error = row.error;
  return item;
}

export class ActivityRepository {
  constructor(private database: SqliteDatabase) {}

  list(limit = 200): ActivityItem[] {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 200;
    return this.database.query((connection) =>
      connection
        .prepare<[number], ActivityRow>(
          "SELECT id, type, title, created_at, download_id, media_id, error FROM activity_logs ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(bounded)
        .map(decode),
    );
  }

  add(item: ActivityItem): ActivityItem {
    this.database.query((connection) =>
      connection
        .prepare(
          "INSERT INTO activity_logs (id, type, title, created_at, download_id, media_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          item.id,
          item.type,
          item.title,
          item.createdAt,
          item.downloadId ?? null,
          item.mediaId ?? null,
          item.error ?? null,
        ),
    );
    return item;
  }
}
