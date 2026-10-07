// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "./browser-manager";
import { registerIPC } from "../ipc/register-ipc";
import { SettingsService } from "../services/settings-service";
import type { BinaryService } from "../services/binary-service";
import type { YtDlpService } from "../downloads/ytdlp-service";

interface SessionFixture extends EventEmitter {
  partition: string;
  cookie: string;
  clearGate?: Promise<void> | undefined;
  clearStorageData: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
  clearAuthCache: ReturnType<typeof vi.fn>;
  cookies: { flushStore: ReturnType<typeof vi.fn> };
  hooks: Record<string, (...args: unknown[]) => unknown>;
}
interface ContentsFixture extends EventEmitter {
  id: number;
  url: string;
  destroyed: boolean;
  closeGate?: Promise<void>;
  session: SessionFixture;
  loadURL(url: string): Promise<void>;
}
interface ViewFixture {
  webContents: ContentsFixture;
}

const fixtures = vi.hoisted(() => ({
  views: [] as ViewFixture[],
  sessions: new Map<string, SessionFixture>(),
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  clearingWhileAlive: [] as boolean[],
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Contents extends Emitter {
    id = fixtures.views.length + 1;
    url = "";
    destroyed = false;
    closeGate?: Promise<void>;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    constructor(readonly session: SessionFixture) {
      super();
    }
    async loadURL(url: string) {
      this.emit(
        "did-start-navigation",
        { url, isMainFrame: true, isSameDocument: false },
        url,
        false,
        true,
      );
      this.session.hooks["onBeforeRequest"]?.(
        { id: 100, url, resourceType: "mainFrame", webContentsId: this.id },
        () => {},
      );
      this.url = url;
      this.emit("did-navigate");
    }
    getURL() {
      return this.url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    setWindowOpenHandler() {}
    stop() {}
    close() {
      void (this.closeGate ?? Promise.resolve()).then(() => {
        this.destroyed = true;
        this.emit("destroyed");
      });
    }
  }
  class View {
    webContents: Contents;
    constructor(options: { webPreferences: { session: SessionFixture } }) {
      this.webContents = new Contents(options.webPreferences.session);
      fixtures.views.push(this);
    }
    setVisible() {}
    setBackgroundColor() {}
    setBounds() {}
  }
  const fromPartition = (partition: string) => {
    let result = fixtures.sessions.get(partition);
    if (result) return result;
    const session = Object.assign(new Emitter(), {
      partition,
      cookie: "old-login",
      clearGate: undefined as Promise<void> | undefined,
      hooks: {} as Record<string, (...args: unknown[]) => unknown>,
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      setDevicePermissionHandler() {},
      clearStorageData: vi.fn(async () => {
        fixtures.clearingWhileAlive.push(
          fixtures.views.some((view) => !view.webContents.destroyed),
        );
        session.cookie = "";
        await session.clearGate;
      }),
      clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}),
      cookies: { flushStore: vi.fn(async () => {}) },
      webRequest: {} as Record<string, (...args: unknown[]) => void>,
    });
    for (const event of [
      "onBeforeRequest",
      "onHeadersReceived",
      "onCompleted",
      "onErrorOccurred",
    ]) {
      session.webRequest[event] = (...args: unknown[]) => {
        session.hooks[event] = args.at(-1) as (...args: unknown[]) => unknown;
      };
    }
    result = session;
    fixtures.sessions.set(partition, result);
    return result;
  };
  return {
    WebContentsView: View,
    session: { fromPartition },
    ipcMain: {
      handle: (
        channel: string,
        action: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
      ) => fixtures.handlers.set(channel, action),
      removeHandler: (channel: string) => fixtures.handlers.delete(channel),
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("browser session and navigation lifecycle", () => {
  let directory: string;
  let settings: SettingsService;
  let manager: BrowserManager;
  let window: BrowserWindow;
  let windowDestroyed: boolean;
  const homepage = "https://example.test/home";

  beforeEach(async () => {
    fixtures.views.length = 0;
    fixtures.sessions.clear();
    fixtures.handlers.clear();
    fixtures.clearingWhileAlive.length = 0;
    directory = await mkdtemp(join(tmpdir(), "mediavault-lifecycle-"));
    settings = new SettingsService(directory);
    await settings.update({ homepage, saveSession: true });
    windowDestroyed = false;
    const mainFrame = { url: "mediavault://app/index.html" };
    const renderer = Object.assign(new EventEmitter(), {
      mainFrame,
      isDestroyed: () => false,
      send: vi.fn(),
      getZoomFactor: () => 1,
    });
    window = Object.assign(new EventEmitter(), {
      webContents: renderer,
      isDestroyed: () => windowDestroyed,
      getContentSize: () => [1440, 940],
      contentView: { addChildView() {}, removeChildView() {} },
    }) as unknown as BrowserWindow;
  });
  afterEach(async () => {
    manager?.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  function create() {
    manager = new BrowserManager(window, settings, {} as YtDlpService);
    return fixtures.views.at(-1)!.webContents;
  }
  function invoke(channel: string, ...args: unknown[]) {
    return fixtures.handlers.get(channel)!(
      {
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      } as IpcMainInvokeEvent,
      ...args,
    );
  }
  function connectIPC() {
    registerIPC(window, manager, settings, {} as BinaryService, "mediavault://app");
  }

  it("waits for the old page to be destroyed before clearing storage and opens the safe homepage", async () => {
    const old = create();
    await manager.open("https://example.test/private-account");
    const closed = deferred();
    old.closeGate = closed.promise;
    const pending = manager.clearData(false);
    await Promise.resolve();
    const startedTooSoon = old.session.clearStorageData.mock.calls.length;
    closed.resolve();
    await pending;
    expect(startedTooSoon).toBe(0);
    expect(fixtures.clearingWhileAlive).toEqual([false]);
    expect(fixtures.views.at(-1)?.webContents.url).toBe(homepage);
    expect(old.session.clearCache).toHaveBeenCalledOnce();
    expect(old.session.clearAuthCache).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "clears the inactive persistent profile when ephemeral (cookiesOnly=%s)",
    async (cookiesOnly) => {
      const saved = create().session;
      await settings.update({ homepage, saveSession: false });
      await manager.changeSession();
      const ephemeral = fixtures.views.at(-1)!.webContents.session;
      await manager.clearData(cookiesOnly);
      expect(ephemeral.cookie).toBe("");
      expect(saved.cookie).toBe("");
      expect(saved.clearStorageData).toHaveBeenCalledWith(
        cookiesOnly ? { storages: ["cookies"] } : {},
      );
      if (cookiesOnly) expect(saved.clearCache).not.toHaveBeenCalled();
      else expect(saved.clearCache).toHaveBeenCalledOnce();
    },
  );

  it("recovers a blank usable view after clear failure without reopening the old account", async () => {
    const old = create();
    await manager.open("https://example.test/private-account");
    old.session.clearStorageData.mockRejectedValueOnce(new Error("private backend diagnostics"));
    await expect(manager.clearData(false)).rejects.toThrow(/^settingsFailed$/);
    expect(old.destroyed).toBe(true);
    expect(fixtures.views).toHaveLength(2);
    expect(fixtures.views.at(-1)?.webContents.url).toBe("");
    await manager.open(homepage);
    expect(manager.getState().url).toBe(homepage);
  });

  it("does not recreate a page when the app closes during storage clearing", async () => {
    const old = create();
    const gate = deferred();
    old.session.clearGate = gate.promise;
    const pending = manager.clearData(false);
    await vi.waitFor(() => expect(old.session.clearStorageData).toHaveBeenCalledOnce());
    manager.dispose();
    windowDestroyed = true;
    gate.resolve();
    await pending;
    expect(fixtures.views).toHaveLength(1);
  });

  it("does not accumulate download listeners when the persistent session is reused", async () => {
    const saved = create().session;
    await manager.changeSession();
    await manager.changeSession();
    expect(saved.listenerCount("will-download")).toBe(1);
  });

  it("serializes clearing and settings changes across their complete session transitions", async () => {
    const old = create();
    connectIPC();
    const gate = deferred();
    old.session.clearGate = gate.promise;
    const clearing = invoke("settings:clearData");
    await vi.waitFor(() => expect(old.session.clearStorageData).toHaveBeenCalledOnce());
    const updating = invoke("settings:update", { homepage, saveSession: false });
    // Drain asynchronous filesystem work; a serialized update cannot persist yet.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const persistedBeforeClear = settings.get().saveSession;
    gate.resolve();
    expect(await clearing).toMatchObject({ ok: true });
    expect(await updating).toMatchObject({ ok: true });
    expect(persistedBeforeClear).toBe(true);
    expect(settings.get().saveSession).toBe(false);
    expect(fixtures.views.at(-1)?.webContents.session.partition).not.toContain("persist:");
  });

  it("uses each preceding update's settings when concurrent persistence toggles are queued", async () => {
    create();
    connectIPC();
    const first = invoke("settings:update", { homepage, saveSession: false });
    const second = invoke("settings:update", { homepage, saveSession: true });
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(settings.get().saveSession).toBe(true);
    expect(fixtures.views.at(-1)?.webContents.session.partition).toBe("persist:mediavault-browser");
  });

  it("continues queued settings work after a preceding clear operation fails", async () => {
    const old = create();
    connectIPC();
    old.session.clearStorageData.mockRejectedValueOnce(new Error("private backend error"));
    const clearing = invoke("settings:clearData");
    const updating = invoke("settings:update", { homepage, saveSession: false });
    expect(await clearing).toEqual({ ok: false, error: "settingsFailed" });
    expect(await updating).toMatchObject({ ok: true });
    expect(fixtures.views.at(-1)?.webContents.session.partition).not.toContain("persist:");
  });

  it("discards old-document media requests started while the next page is loading", () => {
    const current = create();
    const hooks = current.session.hooks;
    const target = "https://example.test/next";
    hooks["onBeforeRequest"]?.(
      { id: 200, url: target, resourceType: "mainFrame", webContentsId: current.id },
      () => {},
    );
    const media = {
      id: 201,
      url: "https://cdn.test/old.mp4",
      resourceType: "media",
      webContentsId: current.id,
      frame: { top: { url: homepage } },
    };
    hooks["onBeforeRequest"]?.(media, () => {});
    hooks["onHeadersReceived"]?.(
      { ...media, statusCode: 200, responseHeaders: { "Content-Type": ["video/mp4"] } },
      () => {},
    );
    current.url = target;
    current.emit("did-navigate");
    expect(manager.getState().media).toEqual([]);
  });

  it("accepts media from cross-origin subframes associated with the committed top page", () => {
    const current = create();
    const hooks = current.session.hooks;
    const media = {
      id: 300,
      url: "https://cdn.test/current.mp4",
      resourceType: "media",
      webContentsId: current.id,
      frame: { url: "https://embed.test/player", top: { url: homepage } },
    };
    hooks["onBeforeRequest"]?.(media, () => {});
    hooks["onHeadersReceived"]?.(
      { ...media, statusCode: 200, responseHeaders: { "Content-Type": ["video/mp4"] } },
      () => {},
    );
    expect(manager.getState().media.map((item) => item.url)).toEqual([media.url]);
  });

  it("drops unassociated requests during navigation but retains direct main-frame media", () => {
    const current = create();
    const hooks = current.session.hooks;
    const target = "https://cdn.test/direct.mp4";
    const main = { id: 350, url: target, resourceType: "mainFrame", webContentsId: current.id };
    hooks["onBeforeRequest"]?.(main, () => {});
    const unknown = {
      id: 351,
      url: "https://cdn.test/unknown.mp4",
      resourceType: "media",
      webContentsId: current.id,
      frame: null,
    };
    hooks["onBeforeRequest"]?.(unknown, () => {});
    hooks["onHeadersReceived"]?.(
      { ...unknown, statusCode: 200, responseHeaders: { "Content-Type": ["video/mp4"] } },
      () => {},
    );
    hooks["onHeadersReceived"]?.(
      {
        ...main,
        statusCode: 200,
        responseHeaders: { "Content-Type": ["video/mp4"], "Content-Length": ["123"] },
      },
      () => {},
    );
    expect(manager.getState().media).toHaveLength(1);
    expect(manager.getState().media[0]).toMatchObject({ url: target, estimatedSize: 123 });
  });

  it("invalidates previous media on a navigation with no main-frame network request", () => {
    const current = create();
    const hooks = current.session.hooks;
    const media = {
      id: 400,
      url: "https://cdn.test/old.mp4",
      resourceType: "media",
      webContentsId: current.id,
      frame: { top: { url: homepage } },
    };
    hooks["onBeforeRequest"]?.(media, () => {});
    hooks["onHeadersReceived"]?.(
      { ...media, statusCode: 200, responseHeaders: { "Content-Type": ["video/mp4"] } },
      () => {},
    );
    const target = "https://example.test/cached";
    current.emit(
      "did-start-navigation",
      { url: target, isMainFrame: true, isSameDocument: false },
      target,
      false,
      true,
    );
    current.url = target;
    current.emit("did-navigate");
    expect(manager.getState().media).toEqual([]);
  });
});
