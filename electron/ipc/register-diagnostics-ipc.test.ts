// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { registerDiagnosticsIPC } from "./register-diagnostics-ipc";

describe("diagnostics IPC argument boundary", () => {
  function setup() {
    const service = {
      get: vi.fn(),
      logs: vi.fn(),
      copyLog: vi.fn(),
      openLogs: vi.fn(),
      clearLogs: vi.fn(),
      exportDiagnostics: vi.fn(),
    };
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerDiagnosticsIPC(service, (channel, action) => handlers.set(channel, action));
    return {
      service,
      call: (channel: string, ...args: unknown[]) =>
        handlers.get(`diagnostics:${channel}`)!(...args),
      handlers,
    };
  }
  it("exposes only six operations and never accepts a renderer path, clipboard text or export object", () => {
    const { service, call, handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      "diagnostics:get",
      "diagnostics:logs",
      "diagnostics:copyLog",
      "diagnostics:openLogs",
      "diagnostics:clearLogs",
      "diagnostics:export",
    ]);
    for (const operation of ["get", "openLogs", "clearLogs", "export"]) {
      expect(() => call(operation, "C:\\private.json")).toThrow("invalidInput");
      call(operation);
    }
    expect(service.exportDiagnostics).toHaveBeenCalledExactlyOnceWith();
    expect(() => call("copyLog", "private clipboard value")).toThrow("invalidInput");
    expect(() => call("copyLog", "a".repeat(64), "extra")).toThrow("invalidInput");
    call("copyLog", "a".repeat(64));
    expect(service.copyLog).toHaveBeenCalledExactlyOnceWith("a".repeat(64));
  });
  it("rejects unbounded and unknown filter fields before calling the service", () => {
    const { service, call } = setup();
    for (const filter of [
      null,
      [],
      { component: "all" },
      { kind: "anything" },
      { limit: 1000000 },
      { path: "private" },
    ])
      expect(() => call("logs", filter)).toThrow("invalidInput");
    expect(() => call("logs", {}, {})).toThrow("invalidInput");
    call("logs", { component: "update", kind: "error" });
    expect(service.logs).toHaveBeenCalledExactlyOnceWith({ component: "update", kind: "error" });
  });
});
