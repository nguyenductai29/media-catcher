import { z } from "zod";
import type { ProductPreferences, ProductSettings } from "../../shared/models";
import type { SettingsRepository } from "../repositories/settings-repository";
import { SnapshotEvents } from "./snapshot-events";

export interface LoginItemAdapter {
  supported: boolean;
  get(): boolean;
  set(enabled: boolean): void;
}
export interface ProductSettingsDependencies {
  repository: Pick<SettingsRepository, "get" | "set">;
  login: LoginItemAdapter;
  establishedUse?: boolean;
}
const preferences = z
  .object({
    closeBehavior: z.enum(["tray", "exit"]),
    startWithWindows: z.boolean(),
    theme: z.enum(["dark", "light", "system"]),
  })
  .strict();
const updateSchema = preferences
  .partial()
  .refine(
    (value) =>
      Object.keys(value).length > 0 && Object.values(value).every((entry) => entry !== undefined),
  );
const storedSchema = preferences.extend({ firstLaunchCompleted: z.boolean() });
type StoredSettings = ProductPreferences & { firstLaunchCompleted: boolean };

/** OS login registration is authoritative; tray availability is never persisted. */
export class ProductSettingsService {
  private current: StoredSettings;
  private trayAvailable = false;
  private actualStartup = false;
  private startupReadable = false;
  private closed = false;
  readonly events = new SnapshotEvents(() => this.snapshot());
  constructor(private readonly deps: ProductSettingsDependencies) {
    const parsed = storedSchema.safeParse(deps.repository.get<unknown>("product"));
    this.current = parsed.success
      ? parsed.data
      : {
          closeBehavior: "tray",
          startWithWindows: false,
          theme: "dark",
          firstLaunchCompleted: deps.establishedUse === true,
        };
    // Record an unfinished first run immediately: browser activity before Finish
    // must not make a later launch misclassify this as an established upgrade.
    if (!parsed.success) deps.repository.set("product", this.current);
    try {
      this.actualStartup = this.readStartup();
    } catch {
      /* Startup settings can be unavailable without preventing the app from opening. */
    }
  }
  private snapshot(): ProductSettings {
    return {
      ...this.current,
      startWithWindows: this.actualStartup,
      startupSupported: this.deps.login.supported && this.startupReadable,
      trayAvailable: this.trayAvailable,
    };
  }
  private readStartup(): boolean {
    if (!this.deps.login.supported) return false;
    try {
      const value = this.deps.login.get();
      if (typeof value !== "boolean") throw new Error();
      this.startupReadable = true;
      return value;
    } catch {
      this.startupReadable = false;
      throw new Error("startupFailed");
    }
  }
  private ensureOpen(): void {
    if (this.closed) throw new Error("unavailable");
  }
  get(): ProductSettings {
    this.actualStartup = this.readStartup();
    return this.snapshot();
  }
  update(input: unknown): ProductSettings {
    this.ensureOpen();
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new Error("invalidInput");
    const changes = parsed.data;
    if (changes.startWithWindows === true && !this.deps.login.supported)
      throw new Error("startupUnsupported");
    const previous = this.readStartup();
    this.actualStartup = previous;
    const desired = changes.startWithWindows ?? previous;
    const changed = desired !== previous;
    if (changed) {
      try {
        this.deps.login.set(desired);
        this.actualStartup = this.readStartup();
        if (this.actualStartup !== desired) throw new Error();
      } catch {
        // Some OS APIs can throw after changing registration. Restore the prior
        // state best effort and never save an unverified enabled preference.
        try {
          this.deps.login.set(previous);
          this.actualStartup = this.readStartup();
        } catch {
          /* get() will report an OS-query failure. */
        }
        throw new Error("startupFailed");
      }
    }
    const next: StoredSettings = {
      ...this.current,
      closeBehavior: changes.closeBehavior ?? this.current.closeBehavior,
      theme: changes.theme ?? this.current.theme,
      startWithWindows: this.actualStartup,
    };
    try {
      this.deps.repository.set("product", next);
    } catch (error) {
      if (changed)
        try {
          this.deps.login.set(previous);
          this.actualStartup = this.readStartup();
        } catch {
          /* Keep the last verified OS state. */
        }
      throw error;
    }
    this.current = next;
    this.events.notify();
    return this.snapshot();
  }
  completeFirstLaunch(): ProductSettings {
    this.ensureOpen();
    this.actualStartup = this.readStartup();
    if (!this.current.firstLaunchCompleted) {
      const next = {
        ...this.current,
        startWithWindows: this.actualStartup,
        firstLaunchCompleted: true,
      };
      this.deps.repository.set("product", next);
      this.current = next;
      this.events.notify();
    }
    return this.snapshot();
  }
  setTrayAvailable(value: boolean): void {
    if (this.closed || this.trayAvailable === value) return;
    this.trayAvailable = value;
    this.events.notify();
  }
  dispose(): void {
    this.closed = true;
    this.events.dispose();
  }
}
