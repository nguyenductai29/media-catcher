// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { registerIPC } from "./register-ipc";
import type { BrowserManager } from "../browser/browser-manager";
import type { SettingsService } from "../services/settings-service";
import type { BinaryService } from "../services/binary-service";
import type { LocalMediaServices } from "./register-local-media-ipc";
import type { DriveIPCServices } from "./register-drive-ipc";
import type { ProductIPCServices } from "./register-product-ipc";
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
    guardMedia: vi.fn(async <T>(_id: string, action: () => T | Promise<T>) => action()),
  };
  const drive = {
    getState: vi.fn(() => ({
      account: { connected: false, configured: false, connecting: false },
      uploads: [],
      settings: { concurrency: 2, autoUpload: false, deleteLocal: "never", chunkSizeMiB: 8 },
      syncing: false,
    })),
    getAccount: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sync: vi.fn(),
    upload: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    open: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    events,
  };
  const candidate = { id: "network-id", url: "https://real.example/media.mp4", origin: "network" };
  const product = {
    settings: { get: vi.fn(), update: vi.fn(), completeFirstLaunch: vi.fn(), events },
    version: () => "0.1.0",
    exit: vi.fn(),
    isExiting: vi.fn(() => false),
  };
  const storage = { get: vi.fn(), clean: vi.fn(), setFingerprintEnabled: vi.fn() };
  const dispose = registerIPC(
    window,
    { getState: () => ({ media: [candidate] }) } as unknown as BrowserManager,
    {} as SettingsService,
    {} as BinaryService,
    "mediavault://app",
    services as unknown as LocalMediaServices,
    drive as unknown as DriveIPCServices,
    product as unknown as ProductIPCServices,
    storage,
  );
  const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    mocks.handlers.get(channel)!(trusted, ...args);
  return { services, drive, product, storage, trusted, invoke, dispose, candidate };
}
describe("local-media IPC security and confirmation", () => {
  it("rejects foreign storage requests and path-shaped cleanup inputs", async () => {
    const f = setup();
    for (const channel of ["storage:get", "storage:clean", "storage:setFingerprintEnabled"])
      expect(
        await mocks.handlers.get(channel)!({ ...f.trusted, sender: {} } as IpcMainInvokeEvent),
      ).toEqual({ ok: false, error: "unavailable" });
    for (const action of ["C:\\Videos", "../Temp", {}, undefined])
      expect(await f.invoke("storage:clean", action)).toEqual({ ok: false, error: "invalidInput" });
    expect(await f.invoke("storage:setFingerprintEnabled", "true")).toEqual({
      ok: false,
      error: "invalidInput",
    });
    expect(f.storage.clean).not.toHaveBeenCalled();
    await f.invoke("storage:clean", "staleTemp");
    expect(f.storage.clean).toHaveBeenCalledWith("staleTemp");
  });
  it("guards product settings and Exit from foreign frames and rejects new work while draining", async () => {
    const f = setup();
    for (const channel of [
      "settings:getProduct",
      "settings:updateProduct",
      "settings:completeFirstLaunch",
      "product:getVersion",
      "window:exit",
    ])
      expect(
        await mocks.handlers.get(channel)!({ ...f.trusted, sender: {} } as IpcMainInvokeEvent),
      ).toEqual({ ok: false, error: "unavailable" });
    expect(f.product.settings.get).not.toHaveBeenCalled();
    expect(f.product.settings.completeFirstLaunch).not.toHaveBeenCalled();
    expect(await f.invoke("product:getVersion")).toEqual({ ok: true, value: "0.1.0" });
    f.product.isExiting.mockReturnValue(true);
    expect(await f.invoke("downloads:add", { mediaId: "network-id" })).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await f.invoke("drive:upload", "known")).toEqual({ ok: false, error: "unavailable" });
    expect(f.services.downloads.add).not.toHaveBeenCalled();
    expect(f.drive.upload).not.toHaveBeenCalled();
    expect(await f.invoke("window:exit")).toEqual({ ok: true, value: undefined });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.product.exit).toHaveBeenCalledTimes(1);
  });
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
    expect(f.services.guardMedia).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue({ response: 1 });
    expect(await f.invoke("library:deleteFile", "known")).toEqual({ ok: true, value: true });
    expect(f.services.library.deleteFile).toHaveBeenCalledWith("known");
    expect(f.services.guardMedia).toHaveBeenCalledWith("known", expect.any(Function));
  });
  it("protects every Drive handler with the same trusted frame boundary", async () => {
    const f = setup();
    for (const channel of [...mocks.handlers.keys()].filter(
      (key) => key.startsWith("drive:") || key.endsWith("Drive"),
    )) {
      for (const event of [
        { ...f.trusted, sender: {} },
        { ...f.trusted, senderFrame: { url: "mediavault://app/index.html" } },
      ])
        expect(await mocks.handlers.get(channel)!(event as IpcMainInvokeEvent, "known")).toEqual({
          ok: false,
          error: "unavailable",
        });
    }
    expect(f.drive.getState).not.toHaveBeenCalled();
    expect(f.drive.connect).not.toHaveBeenCalled();
  });
  it("accepts only opaque IDs for upload, queue control and official Drive opening", async () => {
    const f = setup();
    for (const method of ["upload", "pause", "resume", "cancel", "retry", "open"] as const) {
      for (const input of [
        "C:\\private\\movie.mp4",
        "../secret",
        "https://drive.google.com/file/d/arbitrary",
        { mediaId: "known", localPath: "secret" },
        "",
        null,
      ])
        expect(await f.invoke(`drive:${method}`, input)).toEqual({
          ok: false,
          error: "invalidInput",
        });
      expect(f.drive[method]).not.toHaveBeenCalled();
      expect(await f.invoke(`drive:${method}`, "known")).toMatchObject({ ok: true });
      expect(f.drive[method]).toHaveBeenCalledWith("known");
    }
  });
  it("maps raw service failures to safe error codes and forwards settings to their strict schema", async () => {
    const f = setup();
    f.drive.connect.mockRejectedValueOnce(new Error("Authorization: Bearer private-token"));
    expect(await f.invoke("drive:connect")).toEqual({ ok: false, error: "unavailable" });
    f.drive.connect.mockRejectedValueOnce(new Error("driveNotConfigured"));
    expect(await f.invoke("drive:connect")).toEqual({ ok: false, error: "driveNotConfigured" });
    f.drive.updateSettings.mockImplementationOnce(() => {
      throw new Error("invalidInput");
    });
    expect(
      await f.invoke("settings:updateDrive", { concurrency: 999, token: "untrusted" }),
    ).toEqual({ ok: false, error: "invalidInput" });
    expect(f.drive.updateSettings).toHaveBeenCalledWith({ concurrency: 999, token: "untrusted" });
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
