import { contextBridge, ipcRenderer } from "electron";
import type { MediaVaultAPI } from "../shared/ipc-types";
import type { BrowserState, WindowState } from "../shared/models";

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
  },
  binaries: { status: () => ipcRenderer.invoke("binaries:status") },
};
contextBridge.exposeInMainWorld("mediaVault", api);
