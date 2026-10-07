import { contextBridge, ipcRenderer } from "electron";
import type { MediaVaultAPI } from "../shared/ipc-types";
import type {
  ActivityItem,
  BrowserState,
  DownloadJob,
  MediaItem,
  WindowState,
  DriveSnapshot,
  ProductSettings,
  ProductRoute,
} from "../shared/models";

function subscribe<T>(channel: string, listener: (state: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, state: T) => listener(state);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
const api: MediaVaultAPI = {
  maintenance: {
    get: () => ipcRenderer.invoke("maintenance:get"),
    checkYtDlp: () => ipcRenderer.invoke("maintenance:checkYtDlp"),
    updateYtDlp: () => ipcRenderer.invoke("maintenance:updateYtDlp"),
    checkApp: () => ipcRenderer.invoke("maintenance:checkApp"),
    downloadApp: () => ipcRenderer.invoke("maintenance:downloadApp"),
    installApp: () => ipcRenderer.invoke("maintenance:installApp"),
  },
  diagnostics: {
    get: () => ipcRenderer.invoke("diagnostics:get"),
    logs: (filter) => ipcRenderer.invoke("diagnostics:logs", filter),
    copyLog: (id) => ipcRenderer.invoke("diagnostics:copyLog", id),
    openLogs: () => ipcRenderer.invoke("diagnostics:openLogs"),
    clearLogs: () => ipcRenderer.invoke("diagnostics:clearLogs"),
    exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export"),
  },
  storage: {
    get: () => ipcRenderer.invoke("storage:get"),
    clean: (action) => ipcRenderer.invoke("storage:clean", action),
    setFingerprintEnabled: (enabled) =>
      ipcRenderer.invoke("storage:setFingerprintEnabled", enabled),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    exit: () => ipcRenderer.invoke("window:exit"),
    getState: () => ipcRenderer.invoke("window:state"),
    onState: (listener) => subscribe<WindowState>("window:changed", listener),
  },
  browser: {
    getState: () => ipcRenderer.invoke("browser:state"),
    open: (url) => ipcRenderer.invoke("browser:open", url),
    back: () => ipcRenderer.invoke("browser:back"),
    forward: () => ipcRenderer.invoke("browser:forward"),
    reload: () => ipcRenderer.invoke("browser:reload"),
    stop: () => ipcRenderer.invoke("browser:stop"),
    home: () => ipcRenderer.invoke("browser:home"),
    scan: () => ipcRenderer.invoke("browser:scan"),
    setBounds: (bounds) => ipcRenderer.invoke("browser:bounds", bounds),
    onState: (listener) => subscribe<BrowserState>("browser:changed", listener),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (settings) => ipcRenderer.invoke("settings:update", settings),
    clearCookies: () => ipcRenderer.invoke("settings:clearCookies"),
    clearBrowserData: () => ipcRenderer.invoke("settings:clearData"),
    getDownloads: () => ipcRenderer.invoke("settings:getDownloads"),
    updateDownloads: (settings) => ipcRenderer.invoke("settings:updateDownloads", settings),
    setLanguage: (language) => ipcRenderer.invoke("settings:setLanguage", language),
    getDrive: () => ipcRenderer.invoke("settings:getDrive"),
    updateDrive: (settings) => ipcRenderer.invoke("settings:updateDrive", settings),
    getProduct: () => ipcRenderer.invoke("settings:getProduct"),
    updateProduct: (settings) => ipcRenderer.invoke("settings:updateProduct", settings),
    completeFirstLaunch: () => ipcRenderer.invoke("settings:completeFirstLaunch"),
  },
  product: {
    getVersion: () => ipcRenderer.invoke("product:getVersion"),
    onChanged: (listener) => subscribe<ProductSettings>("product:changed", listener),
    onNavigate: (listener) => subscribe<ProductRoute>("product:navigate", listener),
  },
  binaries: {
    status: () => ipcRenderer.invoke("binaries:status"),
    getStatus: () => ipcRenderer.invoke("binaries:getStatus"),
  },
  downloads: {
    list: () => ipcRenderer.invoke("downloads:list"),
    add: (input) => ipcRenderer.invoke("downloads:add", input),
    chooseDirectory: () => ipcRenderer.invoke("downloads:chooseDirectory"),
    pause: (id) => ipcRenderer.invoke("downloads:pause", id),
    resume: (id) => ipcRenderer.invoke("downloads:resume", id),
    cancel: (id) => ipcRenderer.invoke("downloads:cancel", id),
    retry: (id) => ipcRenderer.invoke("downloads:retry", id),
    pauseAll: () => ipcRenderer.invoke("downloads:pauseAll"),
    resumeAll: () => ipcRenderer.invoke("downloads:resumeAll"),
    clearCompleted: () => ipcRenderer.invoke("downloads:clearCompleted"),
    openFolder: (id) => ipcRenderer.invoke("downloads:openFolder", id),
    play: (id) => ipcRenderer.invoke("downloads:play", id),
    onChanged: (listener) => subscribe<DownloadJob[]>("downloads:changed", listener),
  },
  library: {
    list: () => ipcRenderer.invoke("library:list"),
    addFile: () => ipcRenderer.invoke("library:addFile"),
    addFolder: (recursive) => ipcRenderer.invoke("library:addFolder", recursive),
    refresh: () => ipcRenderer.invoke("library:refresh"),
    remove: (id) => ipcRenderer.invoke("library:remove", id),
    deleteFile: (id) => ipcRenderer.invoke("library:deleteFile", id),
    openFolder: (id) => ipcRenderer.invoke("library:openFolder", id),
    play: (id) => ipcRenderer.invoke("library:play", id),
    openExternal: (id) => ipcRenderer.invoke("library:openExternal", id),
    onChanged: (listener) => subscribe<MediaItem[]>("library:changed", listener),
  },
  activity: {
    list: () => ipcRenderer.invoke("activity:list"),
    onChanged: (listener) => subscribe<ActivityItem[]>("activity:changed", listener),
  },
  drive: {
    getState: () => ipcRenderer.invoke("drive:getState"),
    getAccount: () => ipcRenderer.invoke("drive:getAccount"),
    connect: () => ipcRenderer.invoke("drive:connect"),
    disconnect: () => ipcRenderer.invoke("drive:disconnect"),
    sync: () => ipcRenderer.invoke("drive:sync"),
    listUploads: () => ipcRenderer.invoke("drive:listUploads"),
    upload: (id) => ipcRenderer.invoke("drive:upload", id),
    pause: (id) => ipcRenderer.invoke("drive:pause", id),
    resume: (id) => ipcRenderer.invoke("drive:resume", id),
    cancel: (id) => ipcRenderer.invoke("drive:cancel", id),
    retry: (id) => ipcRenderer.invoke("drive:retry", id),
    open: (id) => ipcRenderer.invoke("drive:open", id),
    onChanged: (listener) => subscribe<DriveSnapshot>("drive:changed", listener),
  },
};
contextBridge.exposeInMainWorld("mediaVault", api);
