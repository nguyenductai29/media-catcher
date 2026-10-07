// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecureStore, type SafeStorageAdapter } from "./secure-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
export function testCipher(): SafeStorageAdapter {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}
describe("OS-backed credential envelope", () => {
  it("encrypts persisted data and binds session ciphertext to its context", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-secrets-"));
    roots.push(root);
    const store = new SecureStore(root, testCipher());
    await store.write("google-auth", { refreshToken: "sensitive-refresh-token" });
    expect(
      (await readFile(join(root, "auth", "google-auth.dat"))).includes(
        Buffer.from("sensitive-refresh-token"),
      ),
    ).toBe(false);
    expect(await store.read("google-auth")).toEqual({ refreshToken: "sensitive-refresh-token" });
    const session = store.seal(
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=secret",
      "account:job",
    );
    expect(store.unseal(session, "account:job")).toContain("upload_id=secret");
    expect(() => store.unseal(session, "another:job")).toThrow(/^driveSecureStorageUnavailable$/);
  });
  it("never persists plaintext when encryption is unavailable or basic_text", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-no-secrets-"));
    roots.push(root);
    for (const adapter of [
      { ...testCipher(), isEncryptionAvailable: () => false },
      { ...testCipher(), getSelectedStorageBackend: () => "basic_text" },
    ]) {
      const store = new SecureStore(root, adapter);
      expect(store.isAvailable()).toBe(false);
      await expect(store.write("google-auth", { secret: "no" })).rejects.toThrow(
        /^driveSecureStorageUnavailable$/,
      );
    }
  });
  it("serializes pending writes before removal so disconnect cannot resurrect credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-remove-secrets-"));
    roots.push(root);
    const store = new SecureStore(root, testCipher());
    const pending = store.write("google-auth", { refreshToken: "token" });
    const removal = store.remove("google-auth");
    await Promise.all([pending, removal]);
    expect(await store.read("google-auth")).toBeUndefined();
    await expect(store.write("../escape", {})).rejects.toThrow(/^invalidInput$/);
  });
});
