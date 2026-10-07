import type {
  DriveAccount,
  DriveSettings,
  DriveSnapshot,
  DriveUpload,
  ErrorCode,
  MediaItem,
} from "../../shared/models";
import type { GoogleAuthService } from "./google-auth-service";
import type { GoogleDriveService } from "./google-drive-service";
import type { UploadManager } from "./upload-manager";
import type { StoredDriveUpload } from "./models";
import type { MediaRepository } from "../repositories/media-repository";
import type { SettingsRepository } from "../repositories/settings-repository";
import type { DriveSettingsService } from "../services/drive-settings-service";
import type { ActivityService } from "../services/activity-service";
import type { LibraryService } from "../library/library-service";
import { SnapshotEvents } from "../services/snapshot-events";
import { uploadError } from "./upload-manager";
import { verifyUpload } from "./upload-types";

interface Dependencies {
  auth: Pick<
    GoogleAuthService,
    "getAccount" | "initialize" | "connect" | "disconnect" | "shutdown" | "events"
  >;
  api: Pick<GoogleDriveService, "getQuota" | "ensureRootFolder" | "getFile">;
  uploads: UploadManager;
  media: MediaRepository;
  settings: SettingsRepository;
  preferences: DriveSettingsService;
  library: Pick<LibraryService, "get" | "deleteAfterUpload">;
  activity: ActivityService;
  openExternal(url: string): Promise<unknown>;
  askDelete(item: MediaItem, signal: AbortSignal): Promise<boolean>;
  onLibraryChanged(): void;
  logError?(code: ErrorCode, jobId?: string): void;
}
const validDriveId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id);

/** Main-process account boundary, metadata synchronization, and post-commit automation. */
export class DriveCoordinator {
  private closing = false;
  private disconnecting = false;
  private epoch = 0;
  private lifecycle = new AbortController();
  private deletionLifecycle = new AbortController();
  private details: Partial<DriveAccount> = {};
  private lastAccountId: string | undefined;
  private syncing = false;
  private error: ErrorCode | undefined;
  private syncWork: Promise<void> | undefined;
  private connectWork: Promise<DriveAccount> | undefined;
  private disconnectWork: Promise<void> | undefined;
  private deletionTail: Promise<void> = Promise.resolve();
  private readonly automation = new Set<Promise<void>>();
  private readonly unsubscribe: Array<() => void>;
  readonly events = new SnapshotEvents(() => this.getState());
  constructor(private readonly deps: Dependencies) {
    const previous = deps.settings.get<unknown>("drive.lastAccountId");
    if (typeof previous === "string" && previous.length <= 200) this.lastAccountId = previous;
    this.unsubscribe = [
      deps.uploads.events.subscribe(() => this.events.notify()),
      deps.auth.events.subscribe((account) => {
        if (!account.connected && !account.connecting && !this.closing && !this.disconnecting) {
          this.epoch++;
          this.lifecycle.abort();
          this.lifecycle = new AbortController();
          this.details = {};
          void deps.uploads
            .suspend()
            .catch((error: unknown) => deps.logError?.(uploadError(error)));
        }
        this.events.notify();
      }),
    ];
  }
  getAccount(): DriveAccount {
    const account = this.deps.auth.getAccount();
    if (this.closing || this.disconnecting)
      return { configured: account.configured, connecting: false, connected: false };
    return account.connected && account.providerAccountId === this.details.providerAccountId
      ? { ...account, ...this.details }
      : account;
  }
  getState(): DriveSnapshot {
    return {
      account: this.getAccount(),
      uploads: this.deps.uploads.list(),
      settings: this.getSettings(),
      syncing: this.syncing,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  private account(): string {
    if (this.closing) throw new Error("unavailable");
    const account = this.getAccount();
    if (!account.connected || !account.providerAccountId) throw new Error("driveNotConnected");
    return account.providerAccountId;
  }
  private current(id: string, epoch: number): void {
    if (epoch !== this.epoch || this.lifecycle.signal.aborted) throw new Error("cancelled");
    if (this.account() !== id) throw new Error("driveAccountChanged");
  }
  private remember(id: string): void {
    this.deps.settings.set("drive.lastAccountId", id);
    this.lastAccountId = id;
  }
  async initialize(): Promise<void> {
    const epoch = this.epoch;
    await this.deps.auth.initialize();
    if (this.closing || epoch !== this.epoch) return;
    const account = this.getAccount();
    if (account.connected && account.providerAccountId) {
      this.remember(account.providerAccountId);
      this.deps.uploads.enable();
      await this.sync();
    } else await this.deps.uploads.suspend();
    this.events.notify();
  }
  connect(): Promise<DriveAccount> {
    if (this.connectWork) return this.connectWork;
    if (this.closing || this.disconnecting) return Promise.reject(new Error("unavailable"));
    const epoch = this.epoch;
    this.connectWork = (async () => {
      const account = await this.deps.auth.connect(this.lifecycle.signal);
      if (!account.providerAccountId) throw new Error("driveAuthFailed");
      this.current(account.providerAccountId, epoch);
      this.remember(account.providerAccountId);
      this.deps.uploads.enable();
      this.deps.activity.add("driveConnected", account.email ?? account.displayName ?? "");
      await this.sync();
      return this.getAccount();
    })().finally(() => {
      this.connectWork = undefined;
      this.events.notify();
    });
    return this.connectWork;
  }
  disconnect(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("unavailable"));
    if (this.disconnectWork) return this.disconnectWork;
    const account = this.getAccount();
    this.disconnecting = true;
    this.epoch++;
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.details = {};
    this.error = undefined;
    this.events.notify();
    this.disconnectWork = (async () => {
      try {
        await this.deps.uploads.suspend();
        await this.syncWork?.catch(() => {});
      } finally {
        // Losing SQLite must never preserve credentials after an explicit disconnect.
        await this.deps.auth.disconnect();
      }
      this.deps.activity.add("driveDisconnected", account.email ?? account.displayName ?? "");
    })().finally(() => {
      this.disconnecting = false;
      this.disconnectWork = undefined;
      this.events.notify();
    });
    return this.disconnectWork;
  }
  sync(): Promise<void> {
    if (this.syncWork) return this.syncWork;
    let id: string;
    try {
      id = this.account();
    } catch (error) {
      return Promise.reject(error);
    }
    const epoch = this.epoch,
      signal = this.lifecycle.signal;
    this.syncing = true;
    this.error = undefined;
    this.events.notify();
    this.syncWork = (async () => {
      const saved = this.deps.settings.get<unknown>(`drive.root.${id}`);
      const [quota, root] = await Promise.all([
        this.deps.api.getQuota(signal),
        this.deps.api.ensureRootFolder(validDriveId(saved) ? saved : undefined, signal),
      ]);
      this.current(id, epoch);
      this.remember(id);
      this.deps.settings.set(`drive.root.${id}`, root.id);
      this.details = {
        providerAccountId: id,
        ...quota,
        rootFolderId: root.id,
        rootFolderName: root.name,
      };
      this.events.notify();
      // Only IDs already associated with this account are inspected. This is not Drive-wide browsing.
      for (const original of this.deps.media.list()) {
        if (original.driveAccountId !== id || !original.driveFileId) continue;
        this.current(id, epoch);
        const file = await this.deps.api.getFile(original.driveFileId, signal);
        this.current(id, epoch);
        const item = this.deps.media.get(original.id);
        if (!item || item.driveAccountId !== id || item.driveFileId !== original.driveFileId)
          continue;
        const available =
          !!file &&
          !file.trashed &&
          file.appProperties.mediavault === "1" &&
          file.appProperties.mediaId === item.id;
        const changed =
          available && (file.size !== item.fileSize || item.driveStatus === "changed");
        const active =
          item.driveStatus &&
          ["queued", "preparing", "uploading", "paused", "finalizing"].includes(item.driveStatus);
        this.deps.media.save({
          ...item,
          driveAvailable: available,
          driveStatus: active
            ? item.driveStatus!
            : !available
              ? "missing"
              : changed
                ? "changed"
                : "completed",
          updatedAt: Date.now(),
        });
      }
      this.deps.onLibraryChanged();
      this.current(id, epoch);
      await this.deps.uploads.reconcile();
    })()
      .catch((error: unknown) => {
        if (epoch === this.epoch && !this.closing && !this.disconnecting) {
          this.error = uploadError(error);
          this.deps.logError?.(this.error);
        }
        throw error;
      })
      .finally(() => {
        this.syncing = false;
        this.syncWork = undefined;
        this.events.notify();
      });
    return this.syncWork;
  }
  getSettings(): DriveSettings {
    return this.deps.preferences.get();
  }
  updateSettings(input: unknown): DriveSettings {
    if (this.closing) throw new Error("unavailable");
    const previous = this.getSettings();
    const settings = this.deps.preferences.update(input);
    if (settings.deleteLocal !== previous.deleteLocal) {
      this.deletionLifecycle.abort();
      this.deletionLifecycle = new AbortController();
    }
    this.deps.uploads.settingsChanged();
    this.events.notify();
    return settings;
  }
  upload(id: string): Promise<DriveUpload> {
    this.account();
    return this.deps.uploads.add(id);
  }
  async pause(id: string): Promise<void> {
    if (this.closing) throw new Error("unavailable");
    return this.deps.uploads.pause(id);
  }
  resume(id: string): void {
    this.deps.uploads.resume(id);
  }
  async cancel(id: string): Promise<void> {
    if (this.closing) throw new Error("unavailable");
    return this.deps.uploads.cancel(id);
  }
  retry(id: string): void {
    this.deps.uploads.retry(id);
  }
  hasActiveWork(): boolean {
    return this.deps.uploads.hasActiveWork();
  }
  withMediaLock<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("unavailable"));
    return this.deps.uploads.withMediaLock(id, action);
  }
  async open(id: string): Promise<void> {
    const accountId = this.account(),
      item = this.deps.library.get(id);
    if (item.driveAccountId !== accountId) throw new Error("driveAccountChanged");
    if (!item.driveAvailable || !validDriveId(item.driveFileId))
      throw new Error("driveFileMissing");
    await this.deps.openExternal(`https://drive.google.com/file/d/${item.driveFileId}/view`);
  }
  downloadCompleted(item: MediaItem): Promise<void> {
    if (this.closing || !this.getSettings().autoUpload) return Promise.resolve();
    const work = this.enqueueAutomatic(item).finally(() => this.automation.delete(work));
    this.automation.add(work);
    return work;
  }
  private async enqueueAutomatic(item: MediaItem): Promise<void> {
    try {
      const account = this.getAccount();
      const id = account.connected ? account.providerAccountId : this.lastAccountId;
      if (!id) throw new Error("driveNotConnected");
      await this.deps.uploads.addAutomatic(item.id, id);
    } catch (error) {
      if (this.closing) return;
      const code = uploadError(error);
      if (code === "driveAlreadyUploaded") return;
      this.deps.activity.add("driveUploadFailed", item.title, { mediaId: item.id, error: code });
      this.deps.logError?.(code);
    }
  }
  uploadCompleted(job: StoredDriveUpload, item: MediaItem): Promise<void> {
    const policy = this.getSettings().deleteLocal;
    if (this.closing || policy === "never") return Promise.resolve();
    const epoch = this.epoch,
      signal = AbortSignal.any([this.lifecycle.signal, this.deletionLifecycle.signal]);
    const check = () => {
      if (signal.aborted) throw new Error("cancelled");
      this.current(job.providerAccountId, epoch);
    };
    const run = this.deletionTail
      .then(async () => {
        check();
        if (policy === "ask" && !(await this.deps.askDelete(item, signal))) return;
        check();
        await this.withMediaLock(item.id, async () => {
          const file = job.driveFileId
            ? await this.deps.api.getFile(job.driveFileId, signal)
            : null;
          check();
          if (!file) throw new Error("driveVerificationFailed");
          verifyUpload(job, file);
          await this.deps.library.deleteAfterUpload(
            item.id,
            {
              driveFileId: file.id,
              providerAccountId: job.providerAccountId,
              fileSize: job.fileSize,
              modifiedAt: job.modifiedAt,
            },
            signal,
          );
          this.deps.onLibraryChanged();
        });
      })
      .catch((error: unknown) => {
        this.deps.logError?.(uploadError(error), job.id);
      });
    this.deletionTail = run;
    return run;
  }
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.epoch++;
    this.lifecycle.abort();
    await this.deps.uploads.shutdown();
    await Promise.allSettled([...this.automation]);
    await this.deps.auth.shutdown();
    await Promise.allSettled([
      this.syncWork,
      this.connectWork,
      this.disconnectWork,
      this.deletionTail,
    ]);
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
    this.events.dispose();
  }
}
