import { z } from "zod";
import type { AppUpdateState } from "../../shared/models";

const providerSchema = z
  .object({
    provider: z.literal("github"),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    publisherName: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value === value.trim() && !/[\p{Cc}]/u.test(value)),
  })
  .strict();
export type UpdateProvider = z.infer<typeof providerSchema>;
export function parseUpdateProvider(value: unknown): UpdateProvider | null {
  if (z.object({ provider: z.null() }).strict().safeParse(value).success) return null;
  const parsed = providerSchema.safeParse(value);
  if (!parsed.success) throw new Error("updateNotConfigured");
  return parsed.data;
}
export interface AppUpdateAdapter {
  check(signal: AbortSignal): Promise<{ available: boolean; version: string }>;
  download(signal: AbortSignal): Promise<void>;
  prepareInstall(signal: AbortSignal): Promise<void>;
  install(): void;
  dispose(): Promise<void>;
}
interface Dependencies {
  currentVersion: string;
  configured: boolean;
  createAdapter(): Promise<AppUpdateAdapter>;
  installAfterDrain(action: () => void): Promise<void>;
}
const safeVersion =
  /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[A-Za-z0-9.-]{1,50})?(?:\+[A-Za-z0-9.-]{1,50})?$/;

/** Checking, downloading and installing are three separate explicit user actions. */
export class AppUpdateService {
  private state: AppUpdateState;
  private adapter: AppUpdateAdapter | undefined;
  private work: Promise<unknown> | undefined;
  private controller: AbortController | undefined;
  private closing = false;
  private installing = false;
  constructor(private readonly deps: Dependencies) {
    this.state = {
      configured: deps.configured,
      currentVersion: deps.currentVersion,
      latestVersion: null,
      status: deps.configured ? "idle" : "unconfigured",
    };
  }
  get(): AppUpdateState {
    return { ...this.state };
  }
  private ensureAvailable(): void {
    if (this.closing) throw new Error("unavailable");
    if (!this.state.configured) throw new Error("updateNotConfigured");
    if (this.work) throw new Error("updateBusy");
  }
  private run<T>(
    action: (adapter: AppUpdateAdapter, signal: AbortSignal) => Promise<T>,
    timeout: number,
  ): Promise<T> {
    this.ensureAvailable();
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), timeout);
    const work = Promise.resolve()
      .then(async () => {
        this.adapter ??= await this.deps.createAdapter();
        if (controller.signal.aborted) throw new Error("cancelled");
        return action(this.adapter, controller.signal);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.message === "cancelled"))
          throw new Error("cancelled");
        if (error instanceof Error && error.message === "updateChecksumMismatch")
          throw new Error("updateChecksumMismatch");
        throw new Error("updateFailed");
      })
      .finally(() => {
        clearTimeout(timer);
        this.work = undefined;
        this.controller = undefined;
      });
    this.work = work;
    return work;
  }
  async check(): Promise<AppUpdateState> {
    this.ensureAvailable();
    if (this.state.status === "ready") return this.get();
    const previous = this.state.status;
    return this.run(async (adapter, signal) => {
      this.state.status = "checking";
      try {
        const result = await adapter.check(signal);
        if (signal.aborted) throw new Error("cancelled");
        if (!safeVersion.test(result.version)) throw new Error("updateFailed");
        this.state.latestVersion = result.version;
        this.state.status = result.available ? "available" : "current";
        return this.get();
      } catch (error) {
        this.state.status = previous;
        throw error;
      }
    }, 45_000);
  }
  async download(): Promise<AppUpdateState> {
    this.ensureAvailable();
    if (this.state.status !== "available") throw new Error("invalidInput");
    return this.run(async (adapter, signal) => {
      this.state.status = "downloading";
      try {
        await adapter.download(signal);
        if (signal.aborted) throw new Error("cancelled");
        this.state.status = "ready";
        return this.get();
      } catch (error) {
        this.state.status = "available";
        throw error;
      }
    }, 10 * 60_000);
  }
  async install(): Promise<void> {
    this.ensureAvailable();
    if (this.state.status !== "ready") throw new Error("invalidInput");
    await this.run(async (adapter, signal) => {
      await adapter.prepareInstall(signal);
      if (signal.aborted) throw new Error("cancelled");
      this.installing = true;
      try {
        await this.deps.installAfterDrain(() => adapter.install());
      } finally {
        this.installing = false;
      }
    }, 120_000);
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    // The explicit install action is waiting for this same application drain.
    if (this.installing) return;
    this.controller?.abort();
    await this.work?.catch(() => {});
    await this.adapter?.dispose();
  }
}
