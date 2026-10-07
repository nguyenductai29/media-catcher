import { access, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { DownloadSettings } from "../../shared/models";
import type { SettingsRepository } from "../repositories/settings-repository";

export const qualitySchema = z.enum([
  "best",
  "selected",
  "2160",
  "1440",
  "1080",
  "720",
  "480",
  "audio",
]);
export const containerSchema = z.enum(["mp4", "mkv", "original"]);
const settingsSchema = z
  .object({
    directory: z.string().min(1).max(2048),
    concurrency: z.number().int().min(1).max(5),
    quality: qualitySchema,
    container: containerSchema,
    autoRetry: z.boolean(),
  })
  .strict();
const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/** Only the default, persisted, or native-picked directories can cross the bridge. */
export class DownloadSettingsService {
  readonly rootDirectory: string;
  readonly thumbnailDirectory: string;
  readonly tempDirectory: string;
  private current: DownloadSettings;
  private approved = new Set<string>();
  constructor(
    private readonly repository: SettingsRepository,
    videosDirectory: string,
    private readonly protectedDirectories: string[] = [],
  ) {
    this.rootDirectory = join(videosDirectory, "MediaVault");
    this.thumbnailDirectory = join(this.rootDirectory, "Thumbnails");
    this.tempDirectory = join(this.rootDirectory, "Temp");
    const parsed = settingsSchema.safeParse(repository.get<unknown>("downloads"));
    this.current =
      parsed.success && this.safePath(parsed.data.directory)
        ? parsed.data
        : {
            directory: join(this.rootDirectory, "Downloads"),
            concurrency: 2,
            quality: "best",
            container: "mp4",
            autoRetry: false,
          };
    this.approved.add(key(resolve(this.current.directory)));
  }
  private safePath(path: string) {
    if (!isAbsolute(path) || /[\p{Cc}]/u.test(path)) return false;
    return this.protectedDirectories.every((blocked) => {
      const rel = relative(resolve(blocked), resolve(path));
      return rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel);
    });
  }
  get(): DownloadSettings {
    return { ...this.current };
  }
  async approveDirectory(path: string): Promise<string> {
    if (!this.safePath(path)) throw new Error("invalidInput");
    try {
      const canonical = await realpath(path);
      if (!this.safePath(canonical) || !(await stat(canonical)).isDirectory())
        throw new Error("invalidInput");
      await access(canonical, constants.W_OK);
      this.approved.add(key(canonical));
      return canonical;
    } catch {
      throw new Error("fileAccessDenied");
    }
  }
  async validateDirectory(path: string): Promise<string> {
    if (!this.safePath(path) || !this.approved.has(key(resolve(path))))
      throw new Error("invalidInput");
    try {
      await mkdir(path, { recursive: true });
      const canonical = await realpath(path);
      if (!this.safePath(canonical)) throw new Error("invalidInput");
      await access(canonical, constants.W_OK);
      this.approved.add(key(canonical));
      return canonical;
    } catch {
      throw new Error("fileAccessDenied");
    }
  }
  async update(input: unknown): Promise<DownloadSettings> {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw new Error("invalidInput");
    const directory = await this.validateDirectory(parsed.data.directory);
    const next = { ...parsed.data, directory };
    this.repository.set("downloads", next);
    this.current = next;
    return this.get();
  }
  getLanguage(): "en" | "vi" {
    return this.repository.get<string>("language") === "vi" ? "vi" : "en";
  }
  setLanguage(language: unknown): void {
    if (language !== "en" && language !== "vi") throw new Error("invalidInput");
    this.repository.set("language", language);
  }
}
