interface Dependencies {
  closeBehavior(): "tray" | "exit";
  trayAvailable(): boolean;
  hide(): void;
  show(): void;
  hasActiveWork(): boolean;
  confirmExit(): Promise<boolean>;
  drain(): Promise<void>;
  finish(): void;
  failed(): void;
}
/** UI visibility is independent of queue lifetime. Only an accepted Exit drains Main. */
export class DesktopLifecycle {
  private exiting = false;
  private complete = false;
  private work: Promise<void> | undefined;
  constructor(private readonly deps: Dependencies) {}
  isExiting(): boolean {
    return this.exiting;
  }
  isComplete(): boolean {
    return this.complete;
  }
  closeWindow(): Promise<void> {
    try {
      if (
        !this.exiting &&
        !this.work &&
        this.deps.closeBehavior() === "tray" &&
        this.deps.trayAvailable()
      ) {
        this.deps.hide();
        return Promise.resolve();
      }
    } catch {
      /* A native settings/tray failure must still allow a confirmed exit. */
    }
    return this.exit();
  }
  exit(): Promise<void> {
    if (this.complete) return Promise.resolve();
    if (this.work) return this.work;
    this.work = (async () => {
      this.deps.show();
      if (!this.exiting && this.deps.hasActiveWork() && !(await this.deps.confirmExit())) return;
      this.exiting = true;
      await this.deps.drain();
      this.complete = true;
      this.deps.finish();
    })()
      .catch(() => this.deps.failed())
      .finally(() => {
        this.work = undefined;
      });
    return this.work;
  }
}
