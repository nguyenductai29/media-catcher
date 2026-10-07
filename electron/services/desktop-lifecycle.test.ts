// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DesktopLifecycle } from "./desktop-lifecycle";

function fixture() {
  const deps = {
    closeBehavior: () => "tray" as "tray" | "exit",
    trayAvailable: () => true,
    hide: vi.fn(),
    show: vi.fn(),
    hasActiveWork: () => true,
    confirmExit: vi.fn(async () => false),
    drain: vi.fn(async () => {}),
    finish: vi.fn(),
    failed: vi.fn(),
  };
  return { deps, lifecycle: new DesktopLifecycle(deps) };
}
describe("desktop lifetime", () => {
  it("hides to a live tray without cancelling background jobs", async () => {
    const f = fixture();
    await f.lifecycle.closeWindow();
    expect(f.deps.hide).toHaveBeenCalledOnce();
    expect(f.deps.drain).not.toHaveBeenCalled();
    expect(f.deps.confirmExit).not.toHaveBeenCalled();
    expect(f.lifecycle.isExiting()).toBe(false);
  });
  it("falls back to confirmation when the tray is unavailable and respects Cancel", async () => {
    const f = fixture();
    f.deps.trayAvailable = () => false;
    await f.lifecycle.closeWindow();
    expect(f.deps.show).toHaveBeenCalledOnce();
    expect(f.deps.confirmExit).toHaveBeenCalledOnce();
    expect(f.deps.drain).not.toHaveBeenCalled();
  });
  it("still confirms exit when native preference lookup fails", async () => {
    const f = fixture();
    f.deps.closeBehavior = () => {
      throw new Error("startupFailed");
    };
    await f.lifecycle.closeWindow();
    expect(f.deps.confirmExit).toHaveBeenCalledOnce();
    expect(f.deps.drain).not.toHaveBeenCalled();
  });
  it("deduplicates explicit exit and waits for draining before destruction", async () => {
    const f = fixture();
    f.deps.confirmExit.mockResolvedValue(true);
    let release!: () => void;
    f.deps.drain.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.lifecycle.exit(),
      second = f.lifecycle.exit();
    await Promise.resolve();
    expect(f.deps.confirmExit).toHaveBeenCalledOnce();
    expect(f.lifecycle.isExiting()).toBe(true);
    expect(f.deps.finish).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(f.deps.drain).toHaveBeenCalledOnce();
    expect(f.deps.finish).toHaveBeenCalledOnce();
    expect(f.lifecycle.isComplete()).toBe(true);
  });
  it("honors Exit preference and keeps services closed if draining fails", async () => {
    const f = fixture();
    f.deps.closeBehavior = () => "exit";
    f.deps.hasActiveWork = () => false;
    f.deps.drain.mockRejectedValueOnce(new Error("databaseFailed"));
    await f.lifecycle.closeWindow();
    expect(f.deps.hide).not.toHaveBeenCalled();
    expect(f.deps.finish).not.toHaveBeenCalled();
    expect(f.deps.failed).toHaveBeenCalledOnce();
    expect(f.lifecycle.isExiting()).toBe(true);
    expect(f.lifecycle.isComplete()).toBe(false);
  });
});
