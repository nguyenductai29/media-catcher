import { z } from "zod";
import type { DriveSettings } from "../../shared/models";
import type { SettingsRepository } from "../repositories/settings-repository";

const schema = z
  .object({
    concurrency: z.number().int().min(1).max(3),
    autoUpload: z.boolean(),
    deleteLocal: z.enum(["never", "ask", "automatic"]),
    chunkSizeMiB: z.number().int().min(1).max(64),
  })
  .strict();

export class DriveSettingsService {
  private current: DriveSettings;
  constructor(private readonly repository: SettingsRepository) {
    const parsed = schema.safeParse(repository.get<unknown>("drive"));
    this.current = parsed.success
      ? parsed.data
      : { concurrency: 2, autoUpload: false, deleteLocal: "never", chunkSizeMiB: 8 };
  }
  get(): DriveSettings {
    return { ...this.current };
  }
  update(input: unknown): DriveSettings {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error("invalidInput");
    this.repository.set("drive", parsed.data);
    this.current = parsed.data;
    return this.get();
  }
}
