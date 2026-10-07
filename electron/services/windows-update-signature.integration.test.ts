// @vitest-environment node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { verifyInstallerSignature } from "./windows-update-signature";
const installer = resolve("release/MediaVault-Setup-0.1.0.exe");
it.runIf(process.platform === "win32" && existsSync(installer))(
  "rejects the actual unsigned MediaVault installer using native PowerShell",
  async () => {
    await expect(
      verifyInstallerSignature(installer, "MediaVault", new AbortController().signal),
    ).rejects.toThrow("updateFailed");
  },
  30_000,
);
it.runIf(process.platform === "win32")(
  "accepts the verified Microsoft Windows system executable and rejects a different pinned publisher",
  async () => {
    const signed = join(
      process.env["SystemRoot"] ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    await expect(
      verifyInstallerSignature(signed, "Microsoft Windows", new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(
      verifyInstallerSignature(signed, "Different Publisher", new AbortController().signal),
    ).rejects.toThrow("updateFailed");
  },
  30_000,
);
