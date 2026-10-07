// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { registerIPC } from "./register-ipc";
import type { BrowserManager } from "../browser/browser-manager";
import type { SettingsService } from "../services/settings-service";
import type { BinaryService } from "../services/binary-service";
import type { LocalMediaServices } from "./register-local-media-ipc";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  confirm: vi.fn(),
  pick: vi.fn(),
  reveal: vi.fn(),
  open: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      action: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
    ) => mocks.handlers.set(channel, action),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
  dialog: { showMessageBox: mocks.confirm, showOpenDialog: mocks.pick },
  shell: { showItemInFolder: mocks.reveal, openPath: mocks.open },
}));
beforeEach(() => {
  mocks.handlers.clear();
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue({ response: 0 });
});
function setup() {
  const frame = { url: "mediavault://app/index.html" };
  const contents = { mainFrame: frame, send: vi.fn(), isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const events = { subscribe: () => () => {} };
  const services = {
    downloads: { list: vi.fn(() => []), add: vi.fn(), events },
    library: {
      get: vi.fn(() => ({ id: "known" })),
      deleteFile: vi.fn(),
      remove: vi.fn(),
      validateKnownFile: vi.fn(async () => "C:\\selected\\movie.mp4"),
      list: vi.fn(() => []),
      events,
    },
    downloadSettings: {
      getLanguage: () => "en",
      get: () => ({ directory: "C:\\selected" }),
      approveDirectory: vi.fn(),
    },
    activity: { list: () => [], events },
  };
  const candidate = { id: "network-id", url: "https://real.example/media.mp4", origin: "network" };
  const dispose = registerIPC(
    window,
    { getState: () => ({ media: [candidate] }) } as unknown as BrowserManager,
    {} as SettingsService,
    {} as BinaryService,
    "mediavault://app",
    services as unknown as LocalMediaServices,
  );
  const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    mocks.handlers.get(channel)!(trusted, ...args);
  return { services, trusted, invoke, dispose, candidate };
}
describe("local-media IPC security and confirmation", () => {
  it("rejects foreign renderers and subframes for new APIs", async () => {
    const f = setup();
    for (const event of [
      { ...f.trusted, sender: {} },
      { ...f.trusted, senderFrame: { url: "mediavault://app/index.html" } },
    ]) {
      expect(await mocks.handlers.get("downloads:list")!(event as IpcMainInvokeEvent)).toEqual({
        ok: false,
        error: "unavailable",
      });
    }
    expect(f.services.downloads.list).not.toHaveBeenCalled();
    f.dispose();
    expect(mocks.handlers.size).toBe(0);
  });
  it("resolves download metadata from the detected candidate and rejects stale IDs", async () => {
    const f = setup();
    expect(await f.invoke("downloads:add", { mediaId: "missing" })).toEqual({
      ok: false,
      error: "invalidInput",
    });
    const input = {
      mediaId: "network-id",
      title: "Movie",
      quality: "best",
      container: "mp4",
      destinationDirectory: "C:\\selected",
    };
    await f.invoke("downloads:add", input);
    expect(f.services.downloads.add).toHaveBeenCalledWith(input, f.candidate);
  });
  it("rejects malformed identifiers and folder recursion values before native operations", async () => {
    const f = setup();
    for (const id of ["../secret", "C:\\secret.mp4", {}, ""])
      expect(await f.invoke("library:deleteFile", id)).toEqual({
        ok: false,
        error: "invalidInput",
      });
    expect(await f.invoke("library:addFolder", { recursive: true, path: "C:\\" })).toEqual({
      ok: false,
      error: "invalidInput",
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.pick).not.toHaveBeenCalled();
  });
  it("deletes only after native confirmation; Cancel leaves file and metadata", async () => {
    const f = setup();
    expect(await f.invoke("library:deleteFile", "known")).toEqual({ ok: true, value: false });
    expect(f.services.library.deleteFile).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue({ response: 1 });
    expect(await f.invoke("library:deleteFile", "known")).toEqual({ ok: true, value: true });
    expect(f.services.library.deleteFile).toHaveBeenCalledWith("known");
  });
  it("returns an opaque preview URL rather than a filesystem URL", async () => {
    const f = setup();
    expect(await f.invoke("library:play", "known")).toEqual({
      ok: true,
      value: "mediavault://media/known/video",
    });
    expect(f.services.library.validateKnownFile).toHaveBeenCalledWith("known");
  });
  it("reveals only a validated library record and never renderer-supplied paths", async () => {
    const f = setup();
    expect(await f.invoke("library:openFolder", "known")).toMatchObject({ ok: true });
    expect(mocks.reveal).toHaveBeenCalledWith("C:\\selected\\movie.mp4");
    mocks.reveal.mockClear();
    expect(await f.invoke("library:openFolder", "C:\\private\\secret.txt")).toEqual({
      ok: false,
      error: "invalidInput",
    });
    f.services.library.validateKnownFile.mockRejectedValueOnce(new Error("fileMissing"));
    expect(await f.invoke("library:openFolder", "missing-record")).toEqual({
      ok: false,
      error: "fileMissing",
    });
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
});
