import type {
  BinaryStatus,
  BrowserSettings,
  BrowserState,
  Result,
  ViewBounds,
  WindowState,
  AddDownloadInput,
  ActivityItem,
  BinaryStatuses,
  DownloadJob,
  DownloadSettings,
  ImportSummary,
  MediaItem,
  DriveAccount,
  DriveUpload,
  DriveSettings,
  DriveSnapshot,
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
    getDownloads(): Promise<Result<DownloadSettings>>;
    updateDownloads(settings: DownloadSettings): Promise<Result<DownloadSettings>>;
    setLanguage(language: "en" | "vi"): Promise<Result<void>>;
    getDrive(): Promise<Result<DriveSettings>>;
    updateDrive(settings: DriveSettings): Promise<Result<DriveSettings>>;
  };
  binaries: {
    status(): Promise<Result<BinaryStatus>>;
    getStatus(): Promise<Result<BinaryStatuses>>;
  };
  downloads: {
    list(): Promise<Result<DownloadJob[]>>;
    add(input: AddDownloadInput): Promise<Result<DownloadJob>>;
    chooseDirectory(): Promise<Result<string | null>>;
    pause(id: string): Promise<Result<void>>;
    resume(id: string): Promise<Result<void>>;
    cancel(id: string): Promise<Result<void>>;
    retry(id: string): Promise<Result<void>>;
    pauseAll(): Promise<Result<void>>;
    resumeAll(): Promise<Result<void>>;
    clearCompleted(): Promise<Result<void>>;
    openFolder(id: string): Promise<Result<void>>;
    play(id: string): Promise<Result<string>>;
    onChanged(listener: (jobs: DownloadJob[]) => void): () => void;
  };
  library: {
    list(): Promise<Result<MediaItem[]>>;
    addFile(): Promise<Result<ImportSummary>>;
    addFolder(recursive: boolean): Promise<Result<ImportSummary>>;
    refresh(): Promise<Result<MediaItem[]>>;
    remove(id: string): Promise<Result<void>>;
    /** Main shows the localized native confirmation before deleting. */
    deleteFile(id: string): Promise<Result<boolean>>;
    openFolder(id: string): Promise<Result<void>>;
    play(id: string): Promise<Result<string>>;
    openExternal(id: string): Promise<Result<void>>;
    onChanged(listener: (items: MediaItem[]) => void): () => void;
  };
  activity: {
    list(): Promise<Result<ActivityItem[]>>;
    onChanged(listener: (items: ActivityItem[]) => void): () => void;
  };
  drive: {
    getState(): Promise<Result<DriveSnapshot>>;
    getAccount(): Promise<Result<DriveAccount>>;
    connect(): Promise<Result<DriveAccount>>;
    disconnect(): Promise<Result<void>>;
    sync(): Promise<Result<void>>;
    listUploads(): Promise<Result<DriveUpload[]>>;
    upload(mediaId: string): Promise<Result<DriveUpload>>;
    pause(uploadId: string): Promise<Result<void>>;
    resume(uploadId: string): Promise<Result<void>>;
    cancel(uploadId: string): Promise<Result<void>>;
    retry(uploadId: string): Promise<Result<void>>;
    open(mediaId: string): Promise<Result<void>>;
    onChanged(listener: (state: DriveSnapshot) => void): () => void;
  };
}
