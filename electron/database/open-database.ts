import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { SqliteDatabase } from "./database";
import { listDatabaseBackups, ownedDatabaseDirectory, validateDatabaseBackup } from "./backups";

export interface DatabaseRecoveryAdapter {
  choose(state: { canRestore: boolean }): Promise<"openFolder" | "restore" | "exit">;
  openDataFolder(path: string): Promise<void>;
}

function restoreDatabase(userDataDirectory: string, backup: string): void {
  const root = realpathSync(userDataDirectory);
  const staged = join(root, `mediavault-restore-${randomUUID()}.pending`);
  const moved: Array<{ original: string; quarantined: string }> = [];
  try {
    if (!validateDatabaseBackup(backup)) throw new Error("databaseRecoveryFailed");
    copyFileSync(backup, staged);
    if (!validateDatabaseBackup(staged)) throw new Error("databaseRecoveryFailed");
    const quarantine = join(
      ownedDatabaseDirectory(root, "quarantine"),
      `${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(quarantine);
    for (const name of ["mediavault.db", "mediavault.db-wal", "mediavault.db-shm"]) {
      const original = join(root, name);
      if (!existsSync(original)) continue;
      const info = lstatSync(original);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("databaseRecoveryFailed");
      const quarantined = join(quarantine, name);
      renameSync(original, quarantined);
      moved.push({ original, quarantined });
    }
    renameSync(staged, join(root, "mediavault.db"));
  } catch (cause) {
    for (const { original, quarantined } of moved.reverse()) {
      try {
        if (!existsSync(original)) renameSync(quarantined, original);
      } catch {
        /* Retained in quarantine for manual recovery. */
      }
    }
    throw new Error("databaseRecoveryFailed", { cause });
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      /* The staged file was published or never created. */
    }
  }
}

/** Never reset data automatically. Native UI owns every recovery decision. */
export async function openDatabaseWithRecovery(
  userDataDirectory: string,
  adapter: DatabaseRecoveryAdapter,
): Promise<SqliteDatabase | null> {
  try {
    return new SqliteDatabase(userDataDirectory);
  } catch {
    /* Keep all files for explicit recovery. */
  }
  for (;;) {
    const backups = listDatabaseBackups(userDataDirectory);
    const choice = await adapter.choose({ canRestore: backups.length > 0 });
    if (choice === "exit") return null;
    if (choice === "openFolder") {
      try {
        await adapter.openDataFolder(userDataDirectory);
      } catch {
        /* Native dialog remains available. */
      }
      continue;
    }
    if (choice !== "restore" || !backups[0]) continue;
    try {
      restoreDatabase(userDataDirectory, backups[0]);
      return new SqliteDatabase(userDataDirectory);
    } catch {
      /* Keep the quarantine and let the user open the folder or exit. */
    }
  }
}
