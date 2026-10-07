// @vitest-environment node
import { describe, expect, it } from "vitest";
import { allowedAppUpdateUrl, updateAsset } from "./electron-app-updater";
const provider = {
  provider: "github" as const,
  owner: "example",
  repo: "MediaVault",
  publisherName: "Example",
};
describe("public application update trust boundary", () => {
  it("allows only the configured public repository and official release asset hosts", () => {
    expect(
      allowedAppUpdateUrl("https://github.com/example/MediaVault/releases.atom", provider),
    ).toBe(true);
    expect(
      allowedAppUpdateUrl("https://release-assets.githubusercontent.com/owned-asset", provider),
    ).toBe(true);
    for (const url of [
      "http://github.com/example/MediaVault/releases",
      "https://github.com/other/project/releases",
      "https://github.com/example/MediaVault-evil/releases",
      "https://token@github.com/example/MediaVault/releases",
      "https://evil.example/file.exe",
      "file:///C:/secret",
      "https://github.com:8443/example/MediaVault/releases",
    ])
      expect(allowedAppUpdateUrl(url, provider)).toBe(false);
  });
  it("requires a single bounded NSIS installer with a SHA-512 digest and expected name", () => {
    const info = {
      version: "0.1.1",
      files: [
        {
          url: "MediaVault-Setup-0.1.1.exe",
          sha512: Buffer.alloc(64).toString("base64"),
          size: 1_000,
        },
      ],
    };
    expect(updateAsset(info)).toMatchObject({ version: "0.1.1", size: 1_000 });
    for (const patch of [
      { url: "https://evil.example/installer.exe" },
      { url: "../MediaVault-Setup-0.1.1.exe" },
      { sha512: "unverified" },
      { size: 3 * 1024 ** 3 },
      { size: -1 },
    ])
      expect(() => updateAsset({ ...info, files: [{ ...info.files[0], ...patch }] })).toThrow(
        "updateFailed",
      );
    expect(() => updateAsset({ ...info, packages: {} })).toThrow("updateFailed");
    expect(() => updateAsset({ ...info, files: [] })).toThrow("updateFailed");
  });
});
