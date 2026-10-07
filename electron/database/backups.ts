import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrations } from "./migrations";

const backupName = /^mediavault-v\d+-(\d{13,})-[a-f\d-]{36}\.db$/i;
const samePath = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
let lastTimestamp = 0;

/** Reject redirected app-owned folders before reading or replacing their contents. */
export function ownedDatabaseDirectory(
  userDataDirectory: string,
  name: "backups" | "quarantine",
): string {
  const root = realpathSync(userDataDirectory);
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(directory), directory))
    throw new Error("databaseFailed");
  return directory;
}

export function validateDatabaseBackup(path: string): boolean {
  let database: Database.Database | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    database = new Database(path, { readonly: true, fileMustExist: true });
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number" || version < 1 || version > migrations.length) return false;
    if (database.pragma("quick_check", { simple: true }) !== "ok") return false;
    for (const table of ["downloads", "media", "activity_logs"])
      database.prepare(`SELECT id FROM ${table} LIMIT 0`).all();
    database.prepare("SELECT key,value_json FROM settings LIMIT 0").all();
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

/** Read-only discovery; absent, invalid, future-version and redirected snapshots are ignored. */
export function listDatabaseBackups(userDataDirectory: string): string[] {
  try {
    const root = realpathSync(userDataDirectory);
    const directory = join(root, "backups");
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !samePath(realpathSync(directory), directory)
    )
      return [];
    return readdirSync(directory)
      .filter((name) => backupName.test(name))
      .sort((a, b) => Number(backupName.exec(b)![1]) - Number(backupName.exec(a)![1]))
      .map((name) => join(directory, name))
      .filter(validateDatabaseBackup);
  } catch {
    return [];
  }
}

/** VACUUM INTO captures committed WAL pages, unlike copying the live database file. */
export function createDatabaseBackup(
  database: Database.Database,
  userDataDirectory: string,
): string {
  const directory = ownedDatabaseDirectory(userDataDirectory, "backups");
  const version = database.pragma("user_version", { simple: true });
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  const target = join(directory, `mediavault-v${version}-${lastTimestamp}-${randomUUID()}.db`);
  const staged = `${target}.pending`;
  try {
    database.prepare("VACUUM INTO ?").run(staged);
    if (!validateDatabaseBackup(staged)) throw new Error("databaseFailed");
    chmodSync(staged, 0o600);
    renameSync(staged, target);
    for (const old of listDatabaseBackups(userDataDirectory).slice(3)) unlinkSync(old);
    return target;
  } catch (cause) {
    try {
      unlinkSync(staged);
    } catch {
      /* Keep the original and any validated backup. */
    }
    throw new Error("databaseFailed", { cause });
  }
}
