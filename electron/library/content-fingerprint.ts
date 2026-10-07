import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/** Duplicate hint only: at most three 1 MiB samples, never a full integrity hash. */
export async function contentFingerprint(path: string, signal?: AbortSignal): Promise<string> {
  const check = () => {
    if (signal?.aborted) throw new Error("cancelled");
  };
  check();
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0) throw new Error("fileMissing");
    const size = before.size,
      sample = Math.min(1024 * 1024, size);
    const offsets = [...new Set([0, Math.floor((size - sample) / 2), size - sample])];
    const hash = createHash("sha256").update(`sample-v1:${size}:`);
    const buffer = Buffer.allocUnsafe(sample);
    for (const offset of offsets) {
      check();
      let received = 0;
      while (received < sample) {
        const result = await file.read(buffer, received, sample - received, offset + received);
        if (!result.bytesRead) throw new Error("fileChanged");
        received += result.bytesRead;
        check();
      }
      hash.update(`${offset}:`).update(buffer);
    }
    const after = await file.stat();
    if (after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("fileChanged");
    return `sample-v1:${size}:${hash.digest("hex")}`;
  } finally {
    await file.close();
  }
}
