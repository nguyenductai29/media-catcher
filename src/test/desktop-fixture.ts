import type { MediaVaultAPI } from "../../shared/ipc-types";
import type {
  ActivityItem,
  BrowserState,
  DownloadJob,
  DriveSnapshot,
  MediaItem,
  ProductSettings,
  StorageSnapshot,
  MaintenanceSnapshot,
  DiagnosticsSnapshot,
} from "../../shared/models";

export const maintenanceState: MaintenanceSnapshot = {
  ytDlp: {
    currentVersion: "2026.01.01",
    latestVersion: null,
    available: false,
    supported: true,
    busy: false,
  },
  app: { configured: false, currentVersion: "0.1.0", latestVersion: null, status: "unconfigured" },
  ffmpegSource: "BtbN FFmpeg Builds (GPL)",
};
export const diagnosticsState: DiagnosticsSnapshot = {
  appVersion: "0.1.0",
  electronVersion: "44.6.0",
  nodeVersion: "24.14.0",
  platform: "win32",
  architecture: "x64",
  schemaVersion: 3,
  databasePath: "C:\\Data\\mediavault.db",
  downloadFolder: "C:\\Videos\\MediaVault\\Downloads",
  binaries: {
    ytDlp: { available: true, state: "ready", version: "2026.01.01" },
    ffmpeg: { available: true, state: "ready", version: "8.0" },
    ffprobe: { available: true, state: "ready", version: "8.0" },
  },
  driveConnected: false,
  browserSession: "persistent",
  activeDownloads: 0,
  activeUploads: 0,
  availableDiskSpace: 1000000000,
  settings: {
    language: "en",
    theme: "dark",
    closeBehavior: "tray",
    startWithWindows: false,
    quality: "best",
    container: "mp4",
    downloadConcurrency: 2,
    uploadConcurrency: 2,
    autoUpload: false,
    deleteLocal: "never",
  },
};

export const storageState: StorageSnapshot = {
  downloads: 0,
  temp: 0,
  thumbnails: 0,
  database: 0,
  logs: 0,
  fingerprintEnabled: false,
};

export const productState: ProductSettings = {
  closeBehavior: "tray",
  startWithWindows: false,
  theme: "dark",
  firstLaunchCompleted: true,
  startupSupported: true,
  trayAvailable: true,
};

export const driveState: DriveSnapshot = {
  account: { connected: false, configured: false, connecting: false },
  uploads: [],
  settings: { concurrency: 2, autoUpload: false, deleteLocal: "never", chunkSizeMiB: 8 },
  syncing: false,
};

export const browserState: BrowserState = {
  url: "https://example.org/",
  title: "Example",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  scanning: false,
  media: [],
  analysis: null,
  error: null,
};

export function desktopFixture() {
  const listeners = new Set<(state: BrowserState) => void>();
  const downloadListeners = new Set<(items: DownloadJob[]) => void>();
  const libraryListeners = new Set<(items: MediaItem[]) => void>();
  const activityListeners = new Set<(items: ActivityItem[]) => void>();
  const productListeners = new Set<(settings: ProductSettings) => void>();
  const navigationListeners = new Set<(route: "/downloads" | "/settings" | "/") => void>();
  const driveListeners = new Set<(state: DriveSnapshot) => void>();
  const success = async () => ({ ok: true as const, value: undefined });
  const api: MediaVaultAPI = {
    maintenance: {
      get: async () => ({ ok: true, value: maintenanceState }),
      checkYtDlp: async () => ({ ok: true, value: maintenanceState.ytDlp }),
      updateYtDlp: async () => ({ ok: true, value: maintenanceState.ytDlp }),
      checkApp: async () => ({ ok: false, error: "updateNotConfigured" }),
      downloadApp: async () => ({ ok: false, error: "updateNotConfigured" }),
      installApp: async () => ({ ok: false, error: "updateNotConfigured" }),
    },
    diagnostics: {
      get: async () => ({ ok: true, value: diagnosticsState }),
      logs: async () => ({ ok: true, value: [] }),
      copyLog: success,
      openLogs: success,
      clearLogs: success,
      exportDiagnostics: async () => ({ ok: true, value: false }),
    },
    window: {
      minimize: success,
      close: success,
      exit: success,
      maximize: async () => ({ ok: true, value: { maximized: true } }),
      getState: async () => ({ ok: true, value: { maximized: false } }),
      onState: () => () => {},
    },
    browser: {
      getState: async () => ({ ok: true, value: browserState }),
      open: success,
      back: success,
      forward: success,
      reload: success,
      stop: success,
      home: success,
      scan: success,
      setBounds: success,
      onState: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    settings: {
      get: async () => ({
        ok: true,
        value: { version: 1, homepage: "https://example.org/", saveSession: true },
      }),
      update: async (settings) => ({ ok: true, value: { ...settings, version: 1 } }),
      clearCookies: success,
      clearBrowserData: success,
      getDownloads: async () => ({
        ok: true,
        value: {
          directory: "C:\\Videos\\MediaVault\\Downloads",
          concurrency: 2,
          quality: "best",
          container: "mp4",
          autoRetry: false,
        },
      }),
      updateDownloads: async (settings) => ({ ok: true, value: settings }),
      setLanguage: success,
      getProduct: async () => ({ ok: true, value: productState }),
      updateProduct: async (prefs) => ({ ok: true, value: { ...productState, ...prefs } }),
      completeFirstLaunch: async () => ({
        ok: true,
        value: { ...productState, firstLaunchCompleted: true },
      }),
      getDrive: async () => ({ ok: true, value: driveState.settings }),
      updateDrive: async (settings) => ({ ok: true, value: settings }),
    },
    product: {
      getVersion: async () => ({ ok: true, value: "0.1.0" }),
      onChanged: (listener) => {
        productListeners.add(listener);
        return () => {
          productListeners.delete(listener);
        };
      },
      onNavigate: (listener) => {
        navigationListeners.add(listener);
        return () => {
          navigationListeners.delete(listener);
        };
      },
    },
    storage: {
      get: async () => ({ ok: true, value: storageState }),
      clean: async () => ({ ok: true, value: storageState }),
      setFingerprintEnabled: async (fingerprintEnabled) => ({
        ok: true,
        value: { ...storageState, fingerprintEnabled },
      }),
    },
    binaries: {
      status: async () => ({ ok: true, value: { available: true, version: "2026.01.01" } }),
      getStatus: async () => ({
        ok: true,
        value: {
          ytDlp: { available: true, state: "ready", version: "2026.01.01" },
          ffmpeg: { available: true, state: "ready", version: "8.0" },
          ffprobe: { available: true, state: "ready", version: "8.0" },
        },
      }),
    },
    downloads: {
      list: async () => ({ ok: true, value: [] }),
      add: async (input) => ({
        ok: true,
        value: {
          id: "job-1",
          sourceUrl: "https://example.org/",
          title: input.title,
          destinationDirectory: input.destinationDirectory,
          quality: input.quality,
          container: input.container,
          downloadedBytes: 0,
          progress: 0,
          status: "queued",
          createdAt: 1,
          updatedAt: 1,
          attempts: 0,
          fromAnalysis: true,
        },
      }),
      chooseDirectory: async () => ({ ok: true, value: null }),
      pause: success,
      resume: success,
      cancel: success,
      retry: success,
      pauseAll: success,
      resumeAll: success,
      clearCompleted: success,
      openFolder: success,
      play: async () => ({ ok: true, value: "mediavault://media/media-1/video" }),
      onChanged: (listener) => {
        downloadListeners.add(listener);
        return () => {
          downloadListeners.delete(listener);
        };
      },
    },
    library: {
      list: async () => ({ ok: true, value: [] }),
      addFile: async () => ({ ok: true, value: { added: 0, skipped: 0, failed: 0 } }),
      addFolder: async () => ({ ok: true, value: { added: 0, skipped: 0, failed: 0 } }),
      refresh: async () => ({ ok: true, value: [] }),
      remove: success,
      deleteFile: async () => ({ ok: true, value: false }),
      openFolder: success,
      openExternal: success,
      play: async () => ({ ok: true, value: "mediavault://media/media-1/video" }),
      onChanged: (listener) => {
        libraryListeners.add(listener);
        return () => {
          libraryListeners.delete(listener);
        };
      },
    },
    activity: {
      list: async () => ({ ok: true, value: [] }),
      onChanged: (listener) => {
        activityListeners.add(listener);
        return () => {
          activityListeners.delete(listener);
        };
      },
    },
    drive: {
      getState: async () => ({ ok: true, value: driveState }),
      getAccount: async () => ({ ok: true, value: driveState.account }),
      connect: async () => ({ ok: false, error: "driveNotConfigured" }),
      disconnect: success,
      sync: success,
      listUploads: async () => ({ ok: true, value: [] }),
      upload: async () => ({ ok: false, error: "driveNotConnected" }),
      pause: success,
      resume: success,
      cancel: success,
      retry: success,
      open: success,
      onChanged: (listener) => {
        driveListeners.add(listener);
        return () => {
          driveListeners.delete(listener);
        };
      },
    },
  };
  return {
    api,
    listeners,
    downloadListeners,
    libraryListeners,
    activityListeners,
    driveListeners,
    productListeners,
    navigationListeners,
    emitProduct: (settings: ProductSettings) =>
      productListeners.forEach((listener) => listener(settings)),
    emitNavigate: (route: "/downloads" | "/settings" | "/") =>
      navigationListeners.forEach((listener) => listener(route)),
    emitDrive: (state: DriveSnapshot) => driveListeners.forEach((listener) => listener(state)),
    emitDownloads: (items: DownloadJob[]) =>
      downloadListeners.forEach((listener) => listener(items)),
    emitLibrary: (items: MediaItem[]) => libraryListeners.forEach((listener) => listener(items)),
    emitActivity: (items: ActivityItem[]) =>
      activityListeners.forEach((listener) => listener(items)),
    emit: (state: BrowserState) => listeners.forEach((listener) => listener(state)),
  };
}
