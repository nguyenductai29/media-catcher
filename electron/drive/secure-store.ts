import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export class SecureStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly userDataDirectory: string,
    private readonly adapter: SafeStorageAdapter,
  ) {}
  isAvailable(): boolean {
    try {
      if (!this.adapter.isEncryptionAvailable()) return false;
      return this.adapter.getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return false;
    }
  }
  seal(value: string, context: string): string {
    if (!this.isAvailable() || value.length > 64 * 1024 || context.length > 1024)
      throw new Error("driveSecureStorageUnavailable");
    try {
      return this.adapter
        .encryptString(JSON.stringify({ version: 1, context, value }))
        .toString("base64");
    } catch {
      throw new Error("driveSecureStorageUnavailable");
    }
  }
  unseal(value: string, context: string): string {
    if (!this.isAvailable() || value.length > 256 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
      throw new Error("driveSecureStorageUnavailable");
    try {
      const decoded: unknown = JSON.parse(this.adapter.decryptString(Buffer.from(value, "base64")));
      if (
        !decoded ||
        typeof decoded !== "object" ||
        !("version" in decoded) ||
        decoded.version !== 1 ||
        !("context" in decoded) ||
        decoded.context !== context ||
        !("value" in decoded) ||
        typeof decoded.value !== "string" ||
        decoded.value.length > 64 * 1024
      )
        throw new Error();
      return decoded.value;
    } catch {
      throw new Error("driveSecureStorageUnavailable");
    }
  }
  private path(key: string): string {
    if (!/^[a-z0-9-]{1,40}$/.test(key)) throw new Error("invalidInput");
    return join(this.userDataDirectory, "auth", `${key}.dat`);
  }
  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    const tracked = result.catch(() => {});
    this.pending.set(key, tracked);
    void tracked.finally(() => {
      if (this.pending.get(key) === tracked) this.pending.delete(key);
    });
    return result;
  }
  async read(key: string): Promise<unknown | undefined> {
    const path = this.path(key);
    return this.serialized(key, async () => {
      try {
        const file = await open(path, "r");
        let value: string;
        try {
          const bytes = Buffer.alloc(256 * 1024 + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > 256 * 1024) throw new Error();
          value = bytes.subarray(0, bytesRead).toString("ascii");
        } finally {
          await file.close();
        }
        return JSON.parse(this.unseal(value, `store:${key}`)) as unknown;
      } catch (error) {
        if (typeof error === "object" && error && "code" in error && error.code === "ENOENT")
          return undefined;
        throw new Error("driveSecureStorageUnavailable");
      }
    });
  }
  async write(key: string, value: unknown): Promise<void> {
    const path = this.path(key);
    const encrypted = this.seal(JSON.stringify(value), `store:${key}`);
    return this.serialized(key, async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(this.userDataDirectory, "auth"), { recursive: true, mode: 0o700 });
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(encrypted, "ascii");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } catch {
        throw new Error("driveSecureStorageUnavailable");
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  }
  async remove(key: string): Promise<void> {
    const path = this.path(key);
    return this.serialized(key, async () => {
      try {
        await unlink(path);
      } catch (error) {
        if (!(typeof error === "object" && error && "code" in error && error.code === "ENOENT"))
          throw new Error("driveSecureStorageUnavailable");
      }
    });
  }
}
