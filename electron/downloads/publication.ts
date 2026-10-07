import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { confinedPath, fileErrorCode, publishFile } from "./download-files";

const identitySchema = z
  .object({
    size: z.number().int().positive().safe(),
    ino: z.string().regex(/^[1-9][0-9]{0,29}$/),
    dev: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
    modifiedAt: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
  })
  .strict();
const fields = {
  stage: z.string().regex(/^\.mediavault-[a-f0-9-]{36}\.pending$/),
  extension: z.string().regex(/^\.[a-z0-9]{1,6}$/),
};
const readySchema = identitySchema
  .extend({ ...fields, state: z.literal("ready").default("ready") })
  .strict();
const preparingSchema = z
  .object({ ...fields, state: z.literal("preparing"), source: identitySchema })
  .strict();
const copyingSchema = z
  .object({
    ...fields,
    state: z.literal("copying"),
    source: identitySchema,
    destination: identitySchema.pick({ ino: true, dev: true }).strict(),
  })
  .strict();
const schema = z.union([readySchema, preparingSchema, copyingSchema]);
type Identity = z.infer<typeof identitySchema>;
type Ready = z.infer<typeof readySchema>;
type Publication = z.infer<typeof schema>;
const journalName = "publication.json";
const identity = (info: BigIntStats): Identity =>
  identitySchema.parse({
    size: Number(info.size),
    ino: info.ino.toString(),
    dev: info.dev.toString(),
    modifiedAt: info.mtimeNs.toString(),
  });
const sameInode = (info: BigIntStats, expected: { ino: string | bigint; dev: string | bigint }) =>
  info.isFile() &&
  !info.isSymbolicLink() &&
  info.ino.toString() === expected.ino.toString() &&
  info.dev.toString() === expected.dev.toString();
const sameIdentity = (info: BigIntStats, expected: Identity) =>
  sameInode(info, expected) &&
  info.size === BigInt(expected.size) &&
  info.mtimeNs.toString() === expected.modifiedAt;

async function readPublication(workDirectory: string): Promise<Publication | undefined> {
  const path = join(workDirectory, journalName);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048)
      throw new Error("fileAccessDenied");
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return undefined;
    throw new Error("fileAccessDenied");
  }
}
/** Flush before each atomic transition; a failed write retains the previous journal. */
async function writePublication(workDirectory: string, record: Publication): Promise<void> {
  const pending = join(workDirectory, `publication-${randomUUID()}.pending`);
  const file = await open(pending, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(pending, join(workDirectory, journalName));
  } finally {
    await unlink(pending).catch(() => {});
  }
}
async function ownedStage(directory: string, record: Ready): Promise<string> {
  const path = confinedPath(directory, record.stage);
  if (!sameIdentity(await lstat(path, { bigint: true }), record)) throw new Error("fileChanged");
  return path;
}
async function removeJournal(workDirectory: string): Promise<void> {
  await unlink(join(workDirectory, journalName)).catch((error: unknown) => {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  });
}

export async function recoverPublication(
  directory: string,
  title: string,
  workDirectory: string,
): Promise<string | undefined> {
  const record = await readPublication(workDirectory);
  if (!record) return undefined;
  if (record.state === "ready")
    return publishFile(
      await ownedStage(directory, record),
      directory,
      title,
      record.extension,
      true,
    );
  const stage = confinedPath(directory, record.stage);
  const info = await lstat(stage, { bigint: true }).catch((error: unknown) => {
    if (fileErrorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    await removeJournal(workDirectory);
    return undefined;
  }
  if (record.state === "copying") {
    // A copy without a ready checkpoint is never publishable, even at full length.
    if (!sameInode(info, record.destination)) throw new Error("fileChanged");
    await unlink(stage);
    await removeJournal(workDirectory);
    return undefined;
  }
  if (sameIdentity(info, record.source)) {
    const ready: Ready = {
      state: "ready",
      stage: record.stage,
      extension: record.extension,
      ...record.source,
    };
    await writePublication(workDirectory, ready);
    return publishFile(await ownedStage(directory, ready), directory, title, ready.extension, true);
  }
  if (info.isFile() && !info.isSymbolicLink() && info.size === 0n) {
    // Exclusive creation may precede its inode checkpoint. Never claim ownership
    // from its name alone; abandon only the intent and leave this empty file.
    await removeJournal(workDirectory);
    return undefined;
  }
  throw new Error("fileChanged");
}

async function copyToOwnedStage(
  source: string,
  stage: string,
  workDirectory: string,
  record: z.infer<typeof preparingSchema>,
  check: () => void,
): Promise<Ready> {
  const destination = await open(stage, "wx", 0o600);
  try {
    const created = await destination.stat({ bigint: true });
    if (!created.isFile() || created.size !== 0n || created.ino === 0n)
      throw new Error("fileChanged");
    await writePublication(workDirectory, {
      ...record,
      state: "copying",
      destination: { ino: created.ino.toString(), dev: created.dev.toString() },
    });
    check();
    const input = await open(source, "r");
    try {
      if (!sameIdentity(await input.stat({ bigint: true }), record.source))
        throw new Error("fileChanged");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < record.source.size) {
        check();
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, record.source.size - position),
          position,
        );
        if (!bytesRead) throw new Error("fileChanged");
        let written = 0;
        while (written < bytesRead) {
          check();
          const { bytesWritten } = await destination.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          );
          if (!bytesWritten) throw new Error("fileAccessDenied");
          written += bytesWritten;
        }
        position += bytesRead;
      }
      if (
        !sameIdentity(await input.stat({ bigint: true }), record.source) ||
        !sameIdentity(await lstat(source, { bigint: true }), record.source)
      )
        throw new Error("fileChanged");
    } finally {
      await input.close();
    }
    check();
    await destination.sync();
    const complete = await destination.stat({ bigint: true });
    if (
      complete.size !== BigInt(record.source.size) ||
      !sameInode(await lstat(stage, { bigint: true }), created)
    )
      throw new Error("fileChanged");
    return {
      state: "ready",
      stage: record.stage,
      extension: record.extension,
      ...identity(complete),
    };
  } finally {
    await destination.close();
  }
}

/** Persist intent before media bytes, inode ownership before copying, and verified
 * completion before exposing a final filename through an exclusive hardlink. */
export async function publishRecoverably(
  source: string,
  directory: string,
  title: string,
  extension: string,
  workDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  const check = () => {
    if (signal?.aborted) throw new Error("cancelled");
  };
  try {
    check();
    const recovered = await recoverPublication(directory, title, workDirectory);
    if (recovered) return recovered;
    check();
    const original = await lstat(source, { bigint: true });
    if (!original.isFile() || original.isSymbolicLink()) throw new Error("fileChanged");
    const preparing = preparingSchema.parse({
      state: "preparing",
      stage: `.mediavault-${randomUUID()}.pending`,
      extension: extension.toLowerCase(),
      source: identity(original),
    });
    await writePublication(workDirectory, preparing);
    check();
    const stage = confinedPath(directory, preparing.stage);
    let ready: Ready;
    let linked = false;
    try {
      await link(source, stage);
      linked = true;
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST") throw error;
    }
    if (linked) {
      if (!sameIdentity(await lstat(stage, { bigint: true }), preparing.source))
        throw new Error("fileChanged");
      const file = await open(stage, "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      ready = {
        state: "ready",
        stage: preparing.stage,
        extension: preparing.extension,
        ...preparing.source,
      };
    } else ready = await copyToOwnedStage(source, stage, workDirectory, preparing, check);
    check();
    await writePublication(workDirectory, ready);
    check();
    // No fallback copy to a visible completed filename: NTFS or another
    // hardlink-capable destination is required.
    return publishFile(await ownedStage(directory, ready), directory, title, ready.extension, true);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "cancelled",
        "fileChanged",
        "fileAccessDenied",
        "unsupportedFormat",
        "insufficientSpace",
        "publicationUnavailable",
      ].includes(error.message)
    )
      throw error;
    throw new Error(fileErrorCode(error) === "ENOSPC" ? "insufficientSpace" : "fileAccessDenied");
  }
}

/** Only after durable output-path checkpointing; never unlinks the final output. */
export async function releasePublication(directory: string, workDirectory: string): Promise<void> {
  const record = await readPublication(workDirectory);
  if (!record) return;
  const stage = confinedPath(directory, record.stage);
  try {
    const info = await lstat(stage, { bigint: true });
    const owned =
      record.state === "ready"
        ? sameIdentity(info, record)
        : record.state === "copying"
          ? sameInode(info, record.destination)
          : sameIdentity(info, record.source);
    if (!owned) throw new Error("fileChanged");
    await unlink(stage);
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error;
  }
  await removeJournal(workDirectory);
}
