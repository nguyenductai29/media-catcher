// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  TrayController,
  type TrayAdapter,
  type TrayActions,
  type TrayHandle,
  type TrayMenuItem,
} from "./tray-controller";

function fixture() {
  let destroyed = false;
  let language = "en";
  let doubleClick: (() => void) | undefined;
  let menu: TrayMenuItem[] = [];
  const handle: TrayHandle = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    isDestroyed: () => destroyed,
    on: vi.fn((_event, listener) => {
      doubleClick = listener;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  };
  const adapter: TrayAdapter = {
    create: vi.fn(() => handle),
    buildMenu: vi.fn((template) => {
      menu = template;
      return template;
    }),
  };
  const actions: TrayActions = {
    open: vi.fn(),
    downloads: vi.fn(),
    pauseDownloads: vi.fn(),
    resumeDownloads: vi.fn(),
    pauseUploads: vi.fn(),
    resumeUploads: vi.fn(),
    settings: vi.fn(),
    exit: vi.fn(),
  };
  const available = vi.fn();
  const error = vi.fn();
  const tray = new TrayController({
    adapter,
    iconPath: "C:/MediaVault/resources/icon.png",
    t: (key, variables) =>
      `${language}:${key}${variables ? ` ${variables.downloads}/${variables.uploads}` : ""}`,
    actions,
    onAvailability: available,
    onError: error,
  });
  return {
    tray,
    adapter,
    handle,
    actions,
    available,
    error,
    menu: () => menu,
    doubleClick: () => doubleClick?.(),
    setLanguage: (value: string) => {
      language = value;
    },
    loseTray: () => {
      destroyed = true;
    },
  };
}
describe("native tray controller", () => {
  it("uses the supplied app icon, builds the localized action menu and reopens on double-click", async () => {
    const f = fixture();
    expect(f.tray.create()).toBe(true);
    expect(f.adapter.create).toHaveBeenCalledWith("C:/MediaVault/resources/icon.png");
    expect(f.available).toHaveBeenLastCalledWith(true);
    const items = f.menu().filter((item) => item.type !== "separator");
    expect(items.map((item) => item.id)).toEqual([
      "open",
      "downloads",
      "pauseDownloads",
      "resumeDownloads",
      "pauseUploads",
      "resumeUploads",
      "settings",
      "exit",
    ]);
    for (const item of items) {
      expect(item.label).toBe(`en:tray.${item.id}`);
      item.click?.();
    }
    f.doubleClick();
    await Promise.resolve();
    await Promise.resolve();
    for (const [key, action] of Object.entries(f.actions))
      expect(action).toHaveBeenCalledTimes(key === "open" ? 2 : 1);
    f.tray.create();
    expect(f.adapter.create).toHaveBeenCalledTimes(1);
    f.tray.dispose();
  });
  it("updates translated menus and bounded active counts without recreating the icon", () => {
    const f = fixture();
    f.tray.create();
    f.setLanguage("vi");
    f.tray.refresh({ activeDownloads: 2, activeUploads: 1 });
    expect(f.handle.setToolTip).toHaveBeenLastCalledWith("vi:tray.activeTooltip 2/1");
    expect(f.menu()[0]?.label).toBe("vi:tray.open");
    expect(f.adapter.create).toHaveBeenCalledTimes(1);
    f.tray.refresh({ activeDownloads: Number.NaN, activeUploads: -1 });
    expect(f.handle.setToolTip).toHaveBeenLastCalledWith("vi:tray.activeTooltip 0/0");
    f.tray.dispose();
  });
  it("reports unavailable and destroys a partial tray if native menu creation fails", () => {
    const f = fixture();
    vi.mocked(f.adapter.buildMenu).mockImplementation(() => {
      throw new Error("native failure path");
    });
    expect(f.tray.create()).toBe(false);
    expect(f.tray.isAvailable()).toBe(false);
    expect(f.available).toHaveBeenLastCalledWith(false);
    expect(f.handle.destroy).toHaveBeenCalledTimes(1);
    expect(f.error).toHaveBeenCalledWith("unavailable");
  });
  it("detects native tray loss so closing the window can fall back safely", () => {
    const f = fixture();
    f.tray.create();
    f.loseTray();
    expect(f.tray.isAvailable()).toBe(false);
    expect(f.available).toHaveBeenLastCalledWith(false);
    f.tray.dispose();
  });
  it("sanitizes rejected tray actions and prevents callbacks after disposal", async () => {
    const f = fixture();
    vi.mocked(f.actions.pauseDownloads).mockRejectedValue(new Error("raw path or URL"));
    f.tray.create();
    f.menu()
      .find((item) => item.id === "pauseDownloads")
      ?.click?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.error).toHaveBeenLastCalledWith("unavailable");
    expect(f.tray.isAvailable()).toBe(true);
    const before = f.menu();
    f.tray.dispose();
    f.tray.dispose();
    before[0]?.click?.();
    f.doubleClick();
    await Promise.resolve();
    expect(f.actions.open).not.toHaveBeenCalled();
    expect(f.handle.destroy).toHaveBeenCalledTimes(1);
    expect(f.available).toHaveBeenLastCalledWith(false);
    expect(f.tray.create()).toBe(false);
  });
  it("keeps an unchanged native menu stable while job snapshots continue arriving", () => {
    const f = fixture();
    f.tray.create();
    f.tray.refresh({ activeDownloads: 1, activeUploads: 1 });
    f.tray.refresh({ activeDownloads: 1, activeUploads: 1 });
    expect(f.adapter.buildMenu).toHaveBeenCalledTimes(1);
    expect(f.handle.setToolTip).toHaveBeenCalledTimes(2);
    f.tray.dispose();
  });
});
