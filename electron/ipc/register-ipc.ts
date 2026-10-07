import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { ErrorCode, Result, ViewBounds } from "../../shared/models";
import type { BrowserManager } from "../browser/browser-manager";
import type { SettingsService } from "../services/settings-service";
import type { BinaryService } from "../services/binary-service";

export function validBounds(value: unknown): value is ViewBounds | null {
  if (value === null) return true;
  if (typeof value !== "object" || !value) return false;
  const b = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) =>
      typeof b[key] === "number" && Number.isFinite(b[key]) && b[key] >= 0 && b[key] <= 16384,
  );
}
export function registerIPC(
  window: BrowserWindow,
  browser: BrowserManager,
  settings: SettingsService,
  binaries: BinaryService,
  trustedOrigin: string,
) {
  const channels: string[] = [];
  let sessionWork: Promise<unknown> = Promise.resolve();
  const withSession = <T>(action: () => Promise<T>): Promise<T> => {
    const run = () => {
      if (window.isDestroyed()) throw new Error("unavailable");
      return action();
    };
    const result = sessionWork.then(run, run);
    sessionWork = result.catch(() => {});
    return result;
  };
  const trusted = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return false;
    try {
      const url = new URL(event.senderFrame.url);
      return trustedOrigin === "mediavault://app"
        ? url.protocol === "mediavault:" && url.host === "app"
        : url.origin === trustedOrigin;
    } catch {
      return false;
    }
  };
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
      if (!trusted(event)) return { ok: false, error: "unavailable" };
      try {
        return { ok: true, value: await action(...args) };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const allowed: ErrorCode[] = [
          "invalidUrl",
          "invalidInput",
          "unavailable",
          "navigationFailed",
          "analysisFailed",
          "analysisTimeout",
          "binaryMissing",
          "binaryInvalid",
          "drmProtected",
          "cancelled",
          "settingsFailed",
        ];
        return {
          ok: false,
          error: allowed.includes(code as ErrorCode) ? (code as ErrorCode) : "unavailable",
        };
      }
    });
  };
  handle("window:minimize", () => window.minimize());
  handle("window:maximize", () => {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return { maximized: window.isMaximized() };
  });
  handle("window:close", () => {
    setImmediate(() => window.close());
  });
  handle("window:state", () => ({ maximized: window.isMaximized() }));
  handle("browser:state", () => browser.getState());
  handle("browser:open", (url) => {
    if (typeof url !== "string") throw new Error("invalidUrl");
    return browser.open(url);
  });
  handle("browser:back", () => browser.back());
  handle("browser:forward", () => browser.forward());
  handle("browser:reload", () => browser.reload());
  handle("browser:stop", () => browser.stop());
  handle("browser:home", () => browser.open(settings.get().homepage));
  handle("browser:scan", () => browser.scan());
  handle("browser:bounds", (bounds) => {
    if (!validBounds(bounds)) throw new Error("invalidInput");
    browser.setBounds(bounds);
  });
  handle("settings:get", () => settings.get());
  handle("settings:update", (input) =>
    withSession(async () => {
      const previous = settings.get();
      const next = await settings.update(input);
      if (previous.saveSession !== next.saveSession) await browser.changeSession();
      return next;
    }),
  );
  handle("settings:clearCookies", () => withSession(() => browser.clearData(true)));
  handle("settings:clearData", () => withSession(() => browser.clearData(false)));
  handle("binaries:status", () => binaries.checkVersion());
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel));
}
