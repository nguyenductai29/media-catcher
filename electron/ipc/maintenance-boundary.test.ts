// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { BrowserManager } from "../browser/browser-manager";
import type { SettingsService } from "../services/settings-service";
import type { BinaryService } from "../services/binary-service";
import type { ProductIPCServices } from "./register-product-ipc";
import type { MaintenanceIPCServices } from "./register-maintenance-ipc";
import type { DiagnosticsIPCServices } from "./register-diagnostics-ipc";
import { registerIPC } from "./register-ipc";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      action: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => mocks.handlers.set(channel, action),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
  dialog: {},
  shell: {},
}));
beforeEach(() => mocks.handlers.clear());
function fixture() {
  const mainFrame = { url: "mediavault://app/index.html" };
  const contents = { mainFrame, isDestroyed: () => false, send: vi.fn() };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  let exiting = false;
  const action = vi.fn(async () => undefined);
  const maintenance = {
    ytDlp: { get: action, check: action, update: action },
    app: { get: () => ({}), check: action, download: action, install: action },
    ffmpegSource: "https://www.gyan.dev/ffmpeg/builds/",
  } as unknown as MaintenanceIPCServices;
  const diagnostics = {
    get: action,
    logs: action,
    copyLog: action,
    openLogs: action,
    clearLogs: action,
    exportDiagnostics: action,
  } as unknown as DiagnosticsIPCServices;
  const remove = registerIPC(
    window,
    {} as BrowserManager,
    {} as SettingsService,
    {} as BinaryService,
    "mediavault://app",
    undefined,
    undefined,
    {
      settings: { events: { subscribe: () => () => {} } },
      isExiting: () => exiting,
      version: () => "0.1.0",
      exit: () => {},
    } as unknown as ProductIPCServices,
    undefined,
    maintenance,
    diagnostics,
  );
  return {
    action,
    remove,
    frame: mainFrame,
    event: { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
    close: () => {
      exiting = true;
    },
  };
}
describe("maintenance and diagnostics IPC boundary", () => {
  it("rejects remote senders, subframes and shutdown mutations before touching services", async () => {
    const { action, frame, event, close } = fixture();
    for (const [channel, handler] of mocks.handlers) {
      if (!channel.startsWith("maintenance:") && !channel.startsWith("diagnostics:")) continue;
      expect(await handler({ ...event, sender: {} } as IpcMainInvokeEvent)).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect(
        await handler({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent),
      ).toEqual({ ok: false, error: "unavailable" });
      frame.url = "https://untrusted.example/";
      expect(await handler(event)).toEqual({ ok: false, error: "unavailable" });
      frame.url = "mediavault://app/index.html";
    }
    close();
    for (const [channel, handler] of mocks.handlers)
      if (channel.startsWith("maintenance:") || channel.startsWith("diagnostics:"))
        expect(await handler(event)).toEqual({ ok: false, error: "unavailable" });
    expect(action).not.toHaveBeenCalled();
  });
  it("returns only public error codes and unregisters every new channel", async () => {
    const { action, event, remove } = fixture();
    action.mockRejectedValueOnce(new Error("updateChecksumMismatch"));
    expect(await mocks.handlers.get("maintenance:updateYtDlp")!(event)).toEqual({
      ok: false,
      error: "updateChecksumMismatch",
    });
    action.mockRejectedValueOnce(new Error("Authorization: private signed URL"));
    expect(await mocks.handlers.get("maintenance:checkApp")!(event)).toEqual({
      ok: false,
      error: "unavailable",
    });
    remove();
    expect(mocks.handlers.size).toBe(0);
  });
});
