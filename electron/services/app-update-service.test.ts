// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AppUpdateService, type AppUpdateAdapter, parseUpdateProvider } from "./app-update-service";

function fixture(configured = true) {
  const adapter: AppUpdateAdapter = {
    check: vi.fn(async () => ({ available: true, version: "0.1.1" })),
    download: vi.fn(async () => {}),
    prepareInstall: vi.fn(async () => {}),
    install: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const createAdapter = vi.fn(async () => adapter);
  const installAfterDrain = vi.fn(async (action: () => void) => action());
  const service = new AppUpdateService({
    currentVersion: "0.1.0",
    configured,
    createAdapter,
    installAfterDrain,
  });
  return { service, adapter, createAdapter, installAfterDrain };
}
describe("user-controlled application updates", () => {
  it("does no automatic network work and refuses unconfigured actions honestly", async () => {
    const { service, createAdapter } = fixture(false);
    expect(service.get()).toMatchObject({
      configured: false,
      status: "unconfigured",
      latestVersion: null,
    });
    await expect(service.check()).rejects.toThrow("updateNotConfigured");
    await expect(service.download()).rejects.toThrow("updateNotConfigured");
    await expect(service.install()).rejects.toThrow("updateNotConfigured");
    expect(createAdapter).not.toHaveBeenCalled();
    await service.shutdown();
  });
  it("checks, downloads and installs only on separate explicit actions, after draining", async () => {
    const { service, adapter, installAfterDrain } = fixture();
    expect(service.get().status).toBe("idle");
    await expect(service.download()).rejects.toThrow("invalidInput");
    expect((await service.check()).status).toBe("available");
    expect(adapter.download).not.toHaveBeenCalled();
    expect((await service.download()).status).toBe("ready");
    expect(adapter.install).not.toHaveBeenCalled();
    await service.install();
    expect(adapter.prepareInstall).toHaveBeenCalledOnce();
    expect(installAfterDrain).toHaveBeenCalledOnce();
    expect(adapter.install).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.prepareInstall).mock.invocationCallOrder[0]).toBeLessThan(
      installAfterDrain.mock.invocationCallOrder[0]!,
    );
  });
  it("does not install after canceled confirmation or verification failure", async () => {
    const { service, adapter, installAfterDrain } = fixture();
    await service.check();
    await service.download();
    installAfterDrain.mockRejectedValueOnce(new Error("cancelled"));
    await expect(service.install()).rejects.toThrow("cancelled");
    expect(adapter.install).not.toHaveBeenCalled();
    vi.mocked(adapter.prepareInstall).mockRejectedValueOnce(
      new Error("signed private URL or stack"),
    );
    await expect(service.install()).rejects.toThrow("updateFailed");
    expect(adapter.install).not.toHaveBeenCalled();
  });
  it("keeps failures sanitized and rejects unexpected release version text", async () => {
    const { service, adapter } = fixture();
    vi.mocked(adapter.check).mockResolvedValueOnce({
      available: true,
      version: "https://secret/token",
    });
    await expect(service.check()).rejects.toThrow("updateFailed");
    expect(service.get()).toMatchObject({ status: "idle", latestVersion: null });
    await service.check();
    vi.mocked(adapter.download).mockRejectedValueOnce(new Error("Authorization: private"));
    await expect(service.download()).rejects.toThrow("updateFailed");
    expect(service.get().status).toBe("available");
    vi.mocked(adapter.download).mockRejectedValueOnce(new Error("updateChecksumMismatch"));
    await expect(service.download()).rejects.toThrow("updateChecksumMismatch");
    expect(service.get().status).toBe("available");
  });
  it("rejects simultaneous operations and aborts work before shutdown finishes", async () => {
    const { service, adapter } = fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(adapter.check).mockImplementationOnce(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          started();
        }),
    );
    const pending = service.check();
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await ready;
    await expect(service.check()).rejects.toThrow("updateBusy");
    await service.shutdown();
    await rejected;
    expect(adapter.dispose).toHaveBeenCalledOnce();
    await expect(service.check()).rejects.toThrow("unavailable");
  });
  it("does not deadlock when an accepted install drains its own maintenance service", async () => {
    const { service, adapter, installAfterDrain } = fixture();
    await service.check();
    await service.download();
    installAfterDrain.mockImplementationOnce(async (action) => {
      await service.shutdown();
      action();
    });
    await service.install();
    expect(adapter.install).toHaveBeenCalledOnce();
  });
});
describe("compiled public update provider", () => {
  it("defaults to unconfigured and permits only explicit public GitHub and a signer", () => {
    expect(parseUpdateProvider({ provider: null })).toBeNull();
    expect(
      parseUpdateProvider({
        provider: "github",
        owner: "example",
        repo: "MediaVault",
        publisherName: "Example Publisher",
      }),
    ).toEqual({
      provider: "github",
      owner: "example",
      repo: "MediaVault",
      publisherName: "Example Publisher",
    });
    for (const patch of [
      { token: "private" },
      { private: true },
      { host: "attacker.test" },
      { owner: "../bad" },
      { publisherName: "" },
      { provider: "generic" },
    ])
      expect(() =>
        parseUpdateProvider({
          provider: "github",
          owner: "example",
          repo: "MediaVault",
          publisherName: "Example Publisher",
          ...patch,
        }),
      ).toThrow("updateNotConfigured");
  });
});
