import {
  WebContentsView,
  session as electronSession,
  type BrowserWindow,
  type Session,
} from "electron";
import type { BrowserState, ViewBounds } from "../../shared/models";
import type { YtDlpService } from "../downloads/ytdlp-service";
import type { SettingsService } from "../services/settings-service";
import { createBrowserSession } from "./browser-session";
import { MediaCandidates, classifyMedia } from "./media-detector";
import { normalizeBrowserUrl } from "./url";
import type { BrowserCookieBridge } from "./browser-cookie-bridge";
import { readCookieMetadata } from "./cookie-metadata";

export class BrowserManager {
  private view!: WebContentsView;
  private session!: Session;
  private bounds: ViewBounds | null = null;
  private candidates = new MediaCandidates();
  private generation = 0;
  private navigationPending = false;
  private viewClosing: Promise<void> | undefined;
  private requests = new Map<number, number>();
  private analysisAbort: AbortController | undefined;
  private analyses = new Set<Promise<void>>();
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private state: BrowserState = {
    url: "",
    title: "",
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    scanning: false,
    media: [],
    analysis: null,
    error: null,
  };

  constructor(
    private window: BrowserWindow,
    private settings: SettingsService,
    private analyzer: YtDlpService,
    private cookies?: BrowserCookieBridge,
  ) {
    this.createView();
    void this.open(settings.get().homepage).catch(() => {});
    window.on("resize", () => this.applyBounds());
    window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) this.setBounds(null);
    });
    window.webContents.on("render-process-gone", () => this.setBounds(null));
  }

  private createView() {
    this.viewClosing = undefined;
    this.session = createBrowserSession(this.settings.get().saveSession);
    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    });
    this.view.setBackgroundColor("#ffffff");
    this.view.setVisible(false);
    this.window.contentView.addChildView(this.view);
    const contents = this.view.webContents;
    this.cookies?.bind({
      cookies: this.session.cookies,
      currentPage: () =>
        this.disposed || contents.isDestroyed()
          ? null
          : { url: this.state.url, generation: this.generation, loading: this.navigationPending },
      metadata: (url, signal) => {
        if (contents.isDestroyed()) return Promise.reject(new Error("browserSessionRequired"));
        return readCookieMetadata(contents.debugger, url, signal);
      },
    });
    const allowNavigation = (event: Electron.Event, url: string) => {
      try {
        normalizeBrowserUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    contents.on("will-navigate", allowNavigation);
    contents.on("will-redirect", allowNavigation);
    contents.on("will-frame-navigate", (event) => allowNavigation(event, event.url));
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const safe = normalizeBrowserUrl(url);
        void this.open(safe).catch(() => {});
      } catch {
        /* Unsupported external schemes are blocked. */
      }
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.beginNavigation(event.url);
    });
    contents.on("did-start-loading", () => {
      this.state.loading = true;
      this.emit();
    });
    contents.on("did-stop-loading", () => {
      this.navigationPending = false;
      this.state.loading = false;
      this.navigationState();
    });
    contents.on("did-navigate", () => {
      this.navigationPending = false;
      this.navigationState();
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) {
        this.navigationPending = false;
        this.beginPage(url);
        this.navigationState();
      }
    });
    contents.on("page-title-updated", (_event, title) => {
      this.state.title = title.slice(0, 500);
      this.emit();
    });
    contents.on("page-favicon-updated", (_event, icons) => {
      this.state.favicon =
        icons.find((icon) => {
          try {
            return !!normalizeBrowserUrl(icon);
          } catch {
            return false;
          }
        }) ?? null;
      this.emit();
    });
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        this.navigationPending = false;
        this.state.error = "navigationFailed";
        this.state.loading = false;
        this.emit();
      }
    });
    contents.on("render-process-gone", () => {
      this.navigationPending = false;
      this.state.error = "navigationFailed";
      this.state.loading = false;
      this.emit();
    });

    const filter = { urls: ["http://*/*", "https://*/*"] };
    this.session.webRequest.onBeforeRequest(filter, (details, callback) => {
      if (details.webContentsId === contents.id) {
        if (details.resourceType === "mainFrame") this.beginNavigation(details.url);
        if (details.resourceType === "mainFrame" || this.belongsToCurrentPage(details.frame)) {
          if (this.requests.size > 5000) this.requests.clear();
          this.requests.set(details.id, this.generation);
        } else this.requests.delete(details.id);
      }
      callback({});
    });
    this.session.webRequest.onHeadersReceived(filter, (details, callback) => {
      callback({});
      if (
        details.webContentsId !== contents.id ||
        this.requests.get(details.id) !== this.generation ||
        details.statusCode < 200 ||
        details.statusCode >= 300
      )
        return;
      const headers = details.responseHeaders ?? {};
      const header = (key: string) =>
        Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1]?.[0];
      const rangeTotal = header("content-range")?.match(/\/(\d+)$/)?.[1];
      const size = Number(
        rangeTotal ?? (details.statusCode === 200 ? header("content-length") : undefined),
      );
      if (
        this.candidates.addNetwork(
          details.url,
          this.state.url,
          header("content-type"),
          Number.isFinite(size) && size > 0 ? size : undefined,
        )
      )
        this.emit();
    });
    this.session.webRequest.onCompleted(filter, (details) => this.requests.delete(details.id));
    this.session.webRequest.onErrorOccurred(filter, (details) => this.requests.delete(details.id));
    this.applyBounds();
  }

  private beginNavigation(url: string) {
    if (!this.navigationPending || this.state.url !== url) this.beginPage(url);
    this.navigationPending = true;
  }
  private belongsToCurrentPage(frame: Electron.WebFrameMain | null | undefined) {
    // The previous document can still issue requests while the next navigation waits.
    if (this.navigationPending) return false;
    try {
      const topUrl = frame?.top?.url;
      if (frame && !topUrl) return false;
      if (!topUrl) return true;
      return normalizeBrowserUrl(topUrl).split("#")[0] === this.state.url.split("#")[0];
    } catch {
      // A detached frame cannot be associated with the current document safely.
      return false;
    }
  }
  private beginPage(url: string) {
    this.generation++;
    this.analysisAbort?.abort();
    this.analysisAbort = undefined;
    this.candidates.clear();
    this.state = {
      ...this.state,
      url,
      title: "",
      favicon: null,
      scanning: false,
      analysis: null,
      error: null,
    };
    if (classifyMedia(url)) this.candidates.addNetwork(url, url);
    this.emit();
  }
  private navigationState() {
    if (this.view.webContents.isDestroyed()) return;
    const contents = this.view.webContents;
    this.state.url = contents.getURL() || this.state.url;
    this.state.canGoBack = contents.navigationHistory.canGoBack();
    this.state.canGoForward = contents.navigationHistory.canGoForward();
    this.emit();
  }
  getState(): BrowserState {
    return { ...this.state, media: this.candidates.list() };
  }
  private emit() {
    if (this.emitTimer || this.disposed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed())
        this.window.webContents.send("browser:changed", this.getState());
    }, 100);
  }
  async open(input: string) {
    const url = normalizeBrowserUrl(input);
    try {
      await this.view.webContents.loadURL(url);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ERR_ABORTED")) return;
      this.state.error = "navigationFailed";
      this.emit();
      throw new Error("navigationFailed");
    }
  }
  back() {
    if (this.view.webContents.navigationHistory.canGoBack())
      this.view.webContents.navigationHistory.goBack();
  }
  forward() {
    if (this.view.webContents.navigationHistory.canGoForward())
      this.view.webContents.navigationHistory.goForward();
  }
  reload() {
    this.view.webContents.reload();
  }
  stop() {
    this.view.webContents.stop();
    this.analysisAbort?.abort();
    this.analysisAbort = undefined;
    this.state.scanning = false;
    this.state.loading = false;
    this.emit();
  }
  scan(): Promise<void> {
    const task = this.scanPage();
    this.analyses.add(task);
    void task.finally(() => this.analyses.delete(task)).catch(() => {});
    return task;
  }
  private async scanPage() {
    if (this.state.scanning) return;
    const url = normalizeBrowserUrl(this.state.url);
    const generation = this.generation;
    const abort = new AbortController();
    this.analysisAbort = abort;
    this.state.scanning = true;
    this.state.error = null;
    this.emit();
    try {
      const analysis = await this.analyzer.analyze(url, abort.signal);
      if (generation !== this.generation || abort.signal.aborted) return;
      this.state.analysis = analysis;
      this.candidates.merge(analysis.formats);
      if (analysis.drmProtected && !analysis.formats.length) this.state.error = "drmProtected";
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return;
      const code = error instanceof Error ? error.message : "";
      this.state.error = [
        "binaryMissing",
        "binaryInvalid",
        "analysisTimeout",
        "drmProtected",
        "browserSessionRequired",
        "networkUnavailable",
      ].includes(code)
        ? (code as
            | "binaryMissing"
            | "binaryInvalid"
            | "analysisTimeout"
            | "drmProtected"
            | "browserSessionRequired"
            | "networkUnavailable")
        : "analysisFailed";
    } finally {
      if (generation === this.generation && this.analysisAbort === abort) {
        this.analysisAbort = undefined;
        this.state.scanning = false;
        this.emit();
      }
    }
  }
  setBounds(bounds: ViewBounds | null) {
    this.bounds = bounds;
    this.applyBounds();
  }
  private applyBounds() {
    if (!this.view || this.view.webContents.isDestroyed() || this.window.isDestroyed()) return;
    if (!this.bounds) {
      this.view.setVisible(false);
      return;
    }
    const [width, height] = this.window.getContentSize();
    const scale = this.window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width ?? 0, Math.round(this.bounds.x * scale)));
    const y = Math.max(40, Math.min(height ?? 0, Math.round(this.bounds.y * scale)));
    const w = Math.max(0, Math.min((width ?? 0) - x, Math.round(this.bounds.width * scale)));
    const h = Math.max(0, Math.min((height ?? 0) - y - 27, Math.round(this.bounds.height * scale)));
    this.view.setBounds({ x, y, width: w, height: h });
    this.view.setVisible(w > 0 && h > 0);
  }
  async changeSession() {
    if (this.disposed || this.window.isDestroyed()) return;
    const url = this.state.url || this.settings.get().homepage;
    await this.destroyView();
    if (this.disposed || this.window.isDestroyed()) return;
    this.createView();
    await this.open(url);
  }
  async clearData(cookiesOnly: boolean) {
    if (this.disposed || this.window.isDestroyed()) return;
    const targets = new Set([
      this.session,
      electronSession.fromPartition("persist:mediavault-browser"),
    ]);
    const homepage = this.settings.get().homepage;
    let cleared = false;
    try {
      // Wait for destruction: stop() only stops navigation, leaving page JavaScript alive.
      await this.destroyView();
      this.beginPage("");
      this.state.canGoBack = false;
      this.state.canGoForward = false;
      const results = await Promise.allSettled(
        [...targets].map(async (target) => {
          await target.clearStorageData(cookiesOnly ? { storages: ["cookies"] } : {});
          if (!cookiesOnly) {
            await target.clearCache();
            await target.clearAuthCache();
          }
          await target.cookies.flushStore();
        }),
      );
      if (results.some((result) => result.status === "rejected")) throw new Error("settingsFailed");
      cleared = true;
    } finally {
      if (!this.disposed && !this.window.isDestroyed()) {
        this.createView();
        if (cleared) await this.open(homepage);
        else {
          this.state.error = "settingsFailed";
          this.emit();
        }
      }
    }
  }
  private destroyView(): Promise<void> {
    if (this.viewClosing) return this.viewClosing;
    const cookieDrain = this.cookies?.invalidate() ?? Promise.resolve();
    this.analysisAbort?.abort();
    this.analysisAbort = undefined;
    const analysisDrain = Promise.allSettled([...this.analyses]);
    this.generation++;
    this.navigationPending = false;
    this.state.scanning = false;
    this.state.loading = false;
    this.session.webRequest.onBeforeRequest(null);
    this.session.webRequest.onHeadersReceived(null);
    this.session.webRequest.onCompleted(null);
    this.session.webRequest.onErrorOccurred(null);
    this.requests.clear();
    const contents = this.view.webContents;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
    if (contents.isDestroyed()) {
      this.viewClosing = Promise.all([cookieDrain, analysisDrain]).then(() => {});
      return this.viewClosing;
    }
    const destroyed = new Promise<void>((resolve) => contents.once("destroyed", resolve));
    this.viewClosing = Promise.all([destroyed, cookieDrain, analysisDrain]).then(() => {});
    contents.close({ waitForBeforeUnload: false });
    return this.viewClosing;
  }
  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.emitTimer);
    return Promise.all([this.destroyView(), this.cookies?.shutdown()]).then(() => {});
  }
}
