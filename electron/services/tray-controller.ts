import type { ErrorCode } from "../../shared/models";

export interface TrayMenuItem {
  id?: string;
  label?: string;
  type?: "normal" | "separator";
  click?: () => void;
}
export interface TrayHandle {
  setContextMenu(menu: unknown): void;
  setToolTip(text: string): void;
  on(event: "double-click", listener: () => void): void;
  isDestroyed(): boolean;
  destroy(): void;
}
export interface TrayAdapter {
  create(iconPath: string): TrayHandle;
  buildMenu(template: TrayMenuItem[]): unknown;
}
export interface TrayActions {
  open(): void | Promise<void>;
  downloads(): void | Promise<void>;
  pauseDownloads(): void | Promise<void>;
  resumeDownloads(): void | Promise<void>;
  pauseUploads(): void | Promise<void>;
  resumeUploads(): void | Promise<void>;
  settings(): void | Promise<void>;
  exit(): void | Promise<void>;
}
export interface TrayCounts {
  activeDownloads: number;
  activeUploads: number;
}
export interface TrayControllerOptions {
  adapter: TrayAdapter;
  iconPath: string;
  t: (key: string, variables?: Record<string, number>) => string;
  actions: TrayActions;
  onAvailability: (available: boolean) => void;
  onError?: (code: ErrorCode) => void;
}
const count = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.min(99999, Math.floor(value)) : 0;

/** Owns only the native tray; jobs and window lifecycle remain in Main services. */
export class TrayController {
  private handle: TrayHandle | undefined;
  private closed = false;
  private available = false;
  private menuSignature: string | undefined;
  private tooltip: string | undefined;
  private counts: TrayCounts = { activeDownloads: 0, activeUploads: 0 };
  constructor(private readonly options: TrayControllerOptions) {}
  private availability(value: boolean): void {
    this.available = value;
    this.options.onAvailability(value);
  }
  private error(): void {
    this.options.onError?.("unavailable");
  }
  private remove(): void {
    const handle = this.handle;
    this.handle = undefined;
    this.menuSignature = undefined;
    this.tooltip = undefined;
    try {
      if (handle && !handle.isDestroyed()) handle.destroy();
    } catch {
      /* Native teardown is best effort. */
    }
    this.availability(false);
  }
  create(): boolean {
    if (this.closed) return false;
    if (this.isAvailable()) return true;
    try {
      this.handle = this.options.adapter.create(this.options.iconPath);
      if (this.handle.isDestroyed()) throw new Error();
      this.handle.on("double-click", () => this.invoke("open"));
      this.render();
      this.availability(true);
      return true;
    } catch {
      this.remove();
      this.error();
      return false;
    }
  }
  isAvailable(): boolean {
    if (this.closed || !this.handle) return false;
    try {
      if (this.handle.isDestroyed()) {
        this.remove();
        return false;
      }
    } catch {
      this.remove();
      return false;
    }
    return this.available;
  }
  private invoke(action: keyof TrayActions): void {
    if (this.closed || !this.isAvailable()) return;
    void Promise.resolve()
      .then(() => {
        if (!this.closed && this.isAvailable()) return this.options.actions[action]();
      })
      .catch(() => this.error());
  }
  private render(): void {
    if (!this.handle) return;
    const item = (action: keyof TrayActions): TrayMenuItem => ({
      id: action,
      label: this.options.t(`tray.${action}`),
      click: () => this.invoke(action),
    });
    const menu: TrayMenuItem[] = [
      item("open"),
      item("downloads"),
      { type: "separator" },
      item("pauseDownloads"),
      item("resumeDownloads"),
      item("pauseUploads"),
      item("resumeUploads"),
      { type: "separator" },
      item("settings"),
      item("exit"),
    ];
    const signature = JSON.stringify(menu.map(({ id, label, type }) => ({ id, label, type })));
    if (signature !== this.menuSignature) {
      this.handle.setContextMenu(this.options.adapter.buildMenu(menu));
      this.menuSignature = signature;
    }
    const tooltip = this.options
      .t("tray.activeTooltip", {
        downloads: this.counts.activeDownloads,
        uploads: this.counts.activeUploads,
      })
      .slice(0, 127);
    if (tooltip !== this.tooltip) {
      this.handle.setToolTip(tooltip);
      this.tooltip = tooltip;
    }
  }
  refresh(counts: TrayCounts): void {
    this.counts = {
      activeDownloads: count(counts.activeDownloads),
      activeUploads: count(counts.activeUploads),
    };
    if (!this.isAvailable()) return;
    try {
      this.render();
    } catch {
      this.remove();
      this.error();
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.remove();
  }
}
