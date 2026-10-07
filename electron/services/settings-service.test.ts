// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsService, migrateSettings } from "./settings-service";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("browser settings", () => {
  it("migrates defaults and ignores invalid persisted values", () => {
    expect(migrateSettings({ homepage: "example.org", saveSession: false })).toEqual({
      version: 1,
      homepage: "https://example.org/",
      saveSession: false,
    });
    expect(migrateSettings({ homepage: "file:///secret", saveSession: "no" })).toEqual({
      version: 1,
      homepage: "https://example.com/",
      saveSession: true,
    });
  });
  it("persists valid updates and rejects unsafe input without changing settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mv-settings-"));
    dirs.push(dir);
    const service = new SettingsService(dir);
    await service.load();
    await service.update({ homepage: "https://example.org", saveSession: false });
    const restored = new SettingsService(dir);
    await restored.load();
    expect(restored.get().saveSession).toBe(false);
    await expect(
      service.update({ homepage: "javascript:alert(1)", saveSession: true }),
    ).rejects.toThrow("invalidUrl");
    expect(JSON.parse(await readFile(join(dir, "browser-settings.json"), "utf8")).saveSession).toBe(
      false,
    );
    await writeFile(join(dir, "browser-settings.json"), "broken JSON");
    await restored.load();
    expect(restored.get().saveSession).toBe(true);
  });
});
