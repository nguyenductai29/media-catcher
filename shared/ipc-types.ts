import type {
  BinaryStatus,
  BrowserSettings,
  BrowserState,
  Result,
  ViewBounds,
  WindowState,
} from "./models";

export interface MediaVaultAPI {
  window: {
    minimize(): Promise<Result<void>>;
    maximize(): Promise<Result<WindowState>>;
    close(): Promise<Result<void>>;
    getState(): Promise<Result<WindowState>>;
    onState(listener: (state: WindowState) => void): () => void;
  };
  browser: {
    getState(): Promise<Result<BrowserState>>;
    open(url: string): Promise<Result<void>>;
    back(): Promise<Result<void>>;
    forward(): Promise<Result<void>>;
    reload(): Promise<Result<void>>;
    stop(): Promise<Result<void>>;
    home(): Promise<Result<void>>;
    scan(): Promise<Result<void>>;
    setBounds(bounds: ViewBounds | null): Promise<Result<void>>;
    onState(listener: (state: BrowserState) => void): () => void;
  };
  settings: {
    get(): Promise<Result<BrowserSettings>>;
    update(
      settings: Pick<BrowserSettings, "homepage" | "saveSession">,
    ): Promise<Result<BrowserSettings>>;
    clearCookies(): Promise<Result<void>>;
    clearBrowserData(): Promise<Result<void>>;
  };
  binaries: { status(): Promise<Result<BinaryStatus>> };
}
