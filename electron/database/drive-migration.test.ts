// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrations } from "./migrations";

function legacyDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, [migrations[0]!]);
  db.exec(`
    INSERT INTO downloads(id,source_url,title,container,quality,destination_directory,downloaded_bytes,progress,status,created_at,updated_at,attempts,from_analysis)
    VALUES('download','https://example.test/file','Preserved movie','mp4','best','C:/Videos',512,100,'completed',1,2,1,0);
    INSERT INTO media(id,download_id,title,source_type,local_path,normalized_path,duration,width,height,resolution,container,file_size,modified_at,created_at,updated_at)
    VALUES('media','download','Preserved movie','download','C:/Videos/movie.mp4','c:/videos/movie.mp4',3,320,180,'320x180','mp4',512,1.25,1,2);
    UPDATE downloads SET media_id='media' WHERE id='download';
    INSERT INTO settings VALUES('sentinel','{"keep":true}',1);
    INSERT INTO activity_logs(id,type,title,created_at,download_id,media_id) VALUES('activity','downloadCompleted','Preserved event',2,'download','media');
  `);
  return db;
}

describe("Drive schema v2 upgrade", () => {
  it("upgrades populated v1 in place, retains links/history/settings, and defaults old media to local-only", () => {
    const db = legacyDatabase();
    try {
      const oldDownload = db.prepare("SELECT * FROM downloads").get();
      const oldActivity = db.prepare("SELECT * FROM activity_logs").get();
      applyMigrations(db, migrations.slice(0, 2));
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(db.prepare("SELECT * FROM downloads").get()).toEqual(oldDownload);
      expect(db.prepare("SELECT * FROM activity_logs").get()).toEqual(oldActivity);
      expect(db.prepare("SELECT value_json FROM settings WHERE key='sentinel'").get()).toEqual({
        value_json: '{"keep":true}',
      });
      expect(
        db
          .prepare(
            "SELECT id,local_available,drive_available,drive_file_id,drive_account_id,drive_status FROM media",
          )
          .get(),
      ).toEqual({
        id: "media",
        local_available: 1,
        drive_available: 0,
        drive_file_id: null,
        drive_account_id: null,
        drive_status: null,
      });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      applyMigrations(db, migrations.slice(0, 2));
      expect(db.prepare("SELECT count(*) AS n FROM activity_logs").get()).toEqual({ n: 1 });
      for (const type of [
        "driveConnected",
        "driveDisconnected",
        "driveUploadQueued",
        "driveUploadStarted",
        "driveUploadPaused",
        "driveUploadResumed",
        "driveUploadCompleted",
        "driveUploadFailed",
        "driveUploadCancelled",
        "localFileDeletedAfterUpload",
      ]) {
        db.prepare("INSERT INTO activity_logs(id,type,title,created_at) VALUES(?,?,?,?)").run(
          type,
          type,
          "Drive history",
          3,
        );
      }
      expect(db.prepare("SELECT count(*) AS n FROM activity_logs").get()).toEqual({ n: 11 });
    } finally {
      db.close();
    }
  });

  it("rolls back v2 ALTERs and activity replacement if the migration transaction fails", () => {
    const db = legacyDatabase();
    try {
      expect(migrations[1]?.version).toBe(2);
      expect(() =>
        applyMigrations(db, [
          migrations[0]!,
          { version: 2, sql: `${migrations[1]!.sql}\nINSERT INTO missing_table VALUES(1);` },
        ]),
      ).toThrow(/^databaseFailed$/);
      expect(db.pragma("user_version", { simple: true })).toBe(1);
      expect(db.prepare("SELECT * FROM activity_logs").all()).toHaveLength(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='drive_uploads'").get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("SELECT name FROM pragma_table_info('media') WHERE name='local_available'")
          .get(),
      ).toBeUndefined();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
