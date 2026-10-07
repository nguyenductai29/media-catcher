import { contextBridge, ipcRenderer } from "electron";
import type { MediaVaultAPI } from "../shared/ipc-types";
import type {
  ActivityItem,
  BrowserState,
  DownloadJob,
  MediaItem,
  WindowState,
} from "../shared/models";

function subscribe<T>(channel: string, listener: (state: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, state: T) => listener(state);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
const api: MediaVaultAPI = {
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
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
};
contextBridge.exposeInMainWorld("mediaVault", api);
