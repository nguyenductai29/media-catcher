import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserSettings } from "../../shared/models";
import { normalizeBrowserUrl } from "../browser/url";

const defaults: BrowserSettings = {
  version: 1,
  homepage: "https://example.com/",
  saveSession: true,
};
export function migrateSettings(value: unknown): BrowserSettings {
  if (!value || typeof value !== "object") return { ...defaults };
  const input = value as Record<string, unknown>;
  let homepage = defaults.homepage;
  try {
    if (typeof input["homepage"] === "string") homepage = normalizeBrowserUrl(input["homepage"]);
  } catch {
    /* Invalid legacy setting uses default. */
  }
  return {
    version: 1,
    homepage,
    saveSession: typeof input["saveSession"] === "boolean" ? input["saveSession"] : true,
  };
}
export class SettingsService {
  private state = { ...defaults };
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  async load() {
    try {
      this.state = migrateSettings(
        JSON.parse(await readFile(join(this.directory, "browser-settings.json"), "utf8")),
      );
    } catch {
      this.state = { ...defaults };
    }
  }
  get() {
    return { ...this.state };
  }
  update(value: unknown): Promise<BrowserSettings> {
    const write = async () => {
      if (!value || typeof value !== "object") throw new Error("invalidInput");
      const input = value as Record<string, unknown>;
      if (typeof input["homepage"] !== "string" || typeof input["saveSession"] !== "boolean")
        throw new Error("invalidInput");
      const next: BrowserSettings = {
        version: 1,
        homepage: normalizeBrowserUrl(input["homepage"]),
        saveSession: input["saveSession"],
      };
      try {
        await mkdir(this.directory, { recursive: true });
        const temp = join(this.directory, "browser-settings.json.tmp");
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temp, join(this.directory, "browser-settings.json"));
      } catch {
        throw new Error("settingsFailed");
      }
      this.state = next;
      return this.get();
    };
    const result = this.writing.then(write, write);
    this.writing = result.catch(() => {});
    return result;
  }
}
