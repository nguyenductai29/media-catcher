import type { MediaVaultAPI } from "../../shared/ipc-types";
import type {
  ActivityItem,
  BrowserState,
  DownloadJob,
  DriveSnapshot,
  MediaItem,
} from "../../shared/models";

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
  const driveListeners = new Set<(state: DriveSnapshot) => void>();
  const success = async () => ({ ok: true as const, value: undefined });
  const api: MediaVaultAPI = {
    window: {
      minimize: success,
      close: success,
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
      getDrive: async () => ({ ok: true, value: driveState.settings }),
      updateDrive: async (settings) => ({ ok: true, value: settings }),
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
    emitDrive: (state: DriveSnapshot) => driveListeners.forEach((listener) => listener(state)),
    emitDownloads: (items: DownloadJob[]) =>
      downloadListeners.forEach((listener) => listener(items)),
    emitLibrary: (items: MediaItem[]) => libraryListeners.forEach((listener) => listener(items)),
    emitActivity: (items: ActivityItem[]) =>
      activityListeners.forEach((listener) => listener(items)),
    emit: (state: BrowserState) => listeners.forEach((listener) => listener(state)),
  };
}
