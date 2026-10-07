// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteDatabase } from "../database/database";
import { SettingsRepository } from "../repositories/settings-repository";
import { ProductSettingsService, type LoginItemAdapter } from "./product-settings-service";

describe("desktop product preferences", () => {
  let directory: string, database: SqliteDatabase, repository: SettingsRepository, enabled: boolean;
  let login: LoginItemAdapter;
  const services: ProductSettingsService[] = [];
  const create = (establishedUse = false) => {
    const service = new ProductSettingsService({ repository, login, establishedUse });
    services.push(service);
    return service;
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mv-product-settings-"));
    database = new SqliteDatabase(directory);
    repository = new SettingsRepository(database);
    enabled = false;
    login = {
      supported: true,
      get: vi.fn(() => enabled),
      set: vi.fn((value) => {
        enabled = value;
      }),
    };
  });
  afterEach(async () => {
    for (const service of services.splice(0)) service.dispose();
    vi.useRealTimers();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("defaults to tray, disabled startup, dark theme and an unfinished first launch without registering startup", () => {
    const service = create();
    expect(service.get()).toEqual({
      closeBehavior: "tray",
      startWithWindows: false,
      theme: "dark",
      firstLaunchCompleted: false,
      startupSupported: true,
      trayAvailable: false,
    });
    expect(login.set).not.toHaveBeenCalled();
  });
  it("reads actual OS registration on every get instead of trusting saved preferences", () => {
    const service = create();
    service.update({ startWithWindows: true });
    expect(service.get().startWithWindows).toBe(true);
    enabled = false;
    expect(service.get().startWithWindows).toBe(false);
    expect(create().get().startWithWindows).toBe(false);
  });
  it("persists only preferences and first-run completion, with runtime capability fields kept out of SQLite", () => {
    const service = create();
    service.update({ closeBehavior: "exit", theme: "system", startWithWindows: true });
    service.completeFirstLaunch();
    service.setTrayAvailable(true);
    expect(service.get()).toMatchObject({
      closeBehavior: "exit",
      theme: "system",
      startWithWindows: true,
      firstLaunchCompleted: true,
      trayAvailable: true,
    });
    expect(repository.get("product")).toEqual({
      closeBehavior: "exit",
      theme: "system",
      startWithWindows: true,
      firstLaunchCompleted: true,
    });
    expect(create().get()).toMatchObject({
      closeBehavior: "exit",
      theme: "system",
      firstLaunchCompleted: true,
      trayAvailable: false,
    });
  });
  it.each([
    {},
    null,
    { theme: "pink" },
    { theme: undefined },
    { closeBehavior: "minimize" },
    { startWithWindows: "true" },
    { firstLaunchCompleted: true },
    { startupSupported: true },
    { trayAvailable: true },
    { token: "private" },
  ])("rejects malformed or forbidden updates %j without applying OS changes", (input) => {
    const service = create();
    const persisted = repository.get("product");
    expect(() => service.update(input)).toThrow(/^invalidInput$/);
    expect(login.set).not.toHaveBeenCalled();
    expect(repository.get("product")).toEqual(persisted);
  });
  it.each(["throws", "ignored"])(
    "does not persist successful startup registration when the OS %s the change",
    (mode) => {
      const service = create();
      const persisted = repository.get("product");
      login.set = vi.fn(() => {
        if (mode === "throws") throw new Error("sensitive registry details");
      });
      expect(() => service.update({ startWithWindows: true })).toThrow(/^startupFailed$/);
      expect(service.get().startWithWindows).toBe(false);
      expect(repository.get("product")).toEqual(persisted);
    },
  );
  it("rejects unsupported enable requests but allows unrelated preferences and reports disabled capability", () => {
    login = {
      supported: false,
      get: vi.fn(() => {
        throw new Error("must not query");
      }),
      set: vi.fn(),
    };
    const service = create();
    expect(service.get()).toMatchObject({ startWithWindows: false, startupSupported: false });
    expect(() => service.update({ startWithWindows: true })).toThrow(/^startupUnsupported$/);
    expect(service.update({ theme: "light", startWithWindows: false })).toMatchObject({
      theme: "light",
      startWithWindows: false,
    });
    expect(login.get).not.toHaveBeenCalled();
    expect(login.set).not.toHaveBeenCalled();
  });
  it("rolls back a changed OS registration when preference persistence fails", () => {
    const service = create();
    vi.spyOn(repository, "set").mockImplementation(() => {
      throw new Error("databaseFailed");
    });
    expect(() => service.update({ theme: "light", startWithWindows: true })).toThrow(
      /^databaseFailed$/,
    );
    expect(enabled).toBe(false);
    expect(service.get()).toMatchObject({ theme: "dark", startWithWindows: false });
  });
  it("preserves an unfinished wizard and marks only established installations without a product record complete", () => {
    const upgraded = create(true);
    expect(upgraded.get().firstLaunchCompleted).toBe(true);
    expect(create().get().firstLaunchCompleted).toBe(true);
    repository.set("product", {
      closeBehavior: "tray",
      startWithWindows: false,
      theme: "dark",
      firstLaunchCompleted: false,
    });
    expect(create(true).get().firstLaunchCompleted).toBe(false);
  });
  it("persists a fresh unfinished wizard before later browser activity resembles an established install", () => {
    expect(create(false).get().firstLaunchCompleted).toBe(false);
    expect(create(true).get().firstLaunchCompleted).toBe(false);
    expect(repository.get("product")).toMatchObject({ firstLaunchCompleted: false });
  });
  it("emits coalesced safe snapshots and sanitizes failed OS reads without crashing event delivery", async () => {
    vi.useFakeTimers();
    const service = create();
    service.get();
    const listener = vi.fn();
    service.events.subscribe(listener);
    service.setTrayAvailable(true);
    service.update({ theme: "light" });
    login.get = vi.fn(() => {
      throw new Error("private registry diagnostics");
    });
    expect(() => service.get()).toThrow(/^startupFailed$/);
    await vi.advanceTimersByTimeAsync(200);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      trayAvailable: true,
      theme: "light",
      startWithWindows: false,
    });
    service.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("starts event snapshots with verified OS state and tolerates unavailable startup queries at app launch", async () => {
    vi.useFakeTimers();
    enabled = true;
    const service = create();
    const listener = vi.fn();
    service.events.subscribe(listener);
    service.setTrayAvailable(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      startWithWindows: true,
      startupSupported: true,
    });
    login.get = vi.fn(() => {
      throw new Error("registry failure");
    });
    const unavailable = create();
    const unavailableListener = vi.fn();
    unavailable.events.subscribe(unavailableListener);
    unavailable.setTrayAvailable(true);
    expect(() => unavailable.get()).toThrow(/^startupFailed$/);
    await vi.advanceTimersByTimeAsync(200);
    expect(unavailableListener.mock.calls[0]?.[0]).toMatchObject({ startupSupported: false });
  });
});
