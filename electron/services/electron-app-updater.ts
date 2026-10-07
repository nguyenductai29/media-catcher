import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AppUpdateAdapter, UpdateProvider } from "./app-update-service";
import type { CustomPublishOptions } from "builder-util-runtime";
import type { AppUpdater } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { UpdateRequestGuard } from "./app-update-http";
import { verifyInstallerSignature } from "./windows-update-signature";

const maxInstallerBytes = 2 * 1024 * 1024 * 1024;
const maxMetadataBytes = 2 * 1024 * 1024;
export function updateAsset(value: unknown): { version: string; sha512: string; size: number } {
  if (!value || typeof value !== "object") throw new Error("updateFailed");
  const info = value as Record<string, unknown>;
  if (
    typeof info["version"] !== "string" ||
    !/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[A-Za-z0-9.-]{1,50})?$/.test(info["version"]) ||
    !Array.isArray(info["files"]) ||
    info["files"].length !== 1 ||
    info["packages"] !== undefined
  )
    throw new Error("updateFailed");
  const file: unknown = info["files"][0];
  if (!file || typeof file !== "object") throw new Error("updateFailed");
  const candidate = file as Record<string, unknown>;
  if (
    candidate["url"] !== `MediaVault-Setup-${info["version"]}.exe` ||
    typeof candidate["sha512"] !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(candidate["sha512"]) ||
    typeof candidate["size"] !== "number" ||
    !Number.isSafeInteger(candidate["size"]) ||
    candidate["size"] <= 0 ||
    candidate["size"] > maxInstallerBytes
  )
    throw new Error("updateFailed");
  return { version: info["version"], sha512: candidate["sha512"], size: candidate["size"] };
}
export function allowedAppUpdateUrl(value: string, provider: UpdateProvider): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return false;
    if (url.hostname === "github.com")
      return url.pathname.startsWith(`/${provider.owner}/${provider.repo}/`);
    if (url.hostname === "api.github.com")
      return url.pathname.startsWith(`/repos/${provider.owner}/${provider.repo}/`);
    return [
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
      "github-releases.githubusercontent.com",
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Loaded only for a configured packaged Windows build after an explicit check. */
export async function createElectronAppUpdater(
  provider: UpdateProvider,
): Promise<AppUpdateAdapter> {
  const [{ NsisUpdater, CancellationToken }, { GitHubProvider }] = await Promise.all([
    import("electron-updater"),
    import("electron-updater/out/providers/GitHubProvider.js"),
  ]);
  const guard = new UpdateRequestGuard((url) => allowedAppUpdateUrl(url, provider));
  class BoundedPublicGitHubProvider extends GitHubProvider {
    constructor(
      _options: CustomPublishOptions,
      updater: AppUpdater,
      runtime: ProviderRuntimeOptions,
    ) {
      super(
        { provider: "github", owner: provider.owner, repo: provider.repo, private: false },
        updater,
        runtime,
      );
      // The public provider extension exposes the same executor that NSIS uses for downloads.
      guard.attach(runtime.executor);
    }
  }
  const updater = new NsisUpdater();
  updater.setFeedURL({ provider: "custom", updateProvider: BoundedPublicGitHubProvider });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.logger = null;
  // Errors also reject the awaited public methods; never log upstream URLs/stacks.
  updater.on("error", () => {});
  const network = updater.netSession;
  network.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowedAppUpdateUrl(details.url, provider) });
  });
  let selected: ReturnType<typeof updateAsset> | undefined;
  let downloaded: string | undefined;
  let activeToken: InstanceType<typeof CancellationToken> | undefined;
  let operationSignal: AbortSignal | undefined;
  let activeOperation: Promise<unknown> | undefined;
  // Replace the upstream verifier as well as checking again before install: its legacy
  // PowerShell fallback accepts unavailable verification, which is not a trust decision.
  updater.verifyUpdateCodeSignature = async (_names, file) => {
    if (!operationSignal) throw new Error("updateFailed");
    await verifyInstallerSignature(file, provider.publisherName, operationSignal);
    return null;
  };
  async function withSignal<T>(
    signal: AbortSignal,
    limit: number,
    action: () => Promise<T>,
  ): Promise<T> {
    if (operationSignal) throw new Error("updateBusy");
    operationSignal = signal;
    const abort = () => {
      activeToken?.cancel();
      void network.closeAllConnections().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    let pending: Promise<T> | undefined;
    try {
      if (signal.aborted) throw new Error("cancelled");
      const result = await guard.run(signal, limit, () => {
        pending = action();
        activeOperation = pending;
        return pending;
      });
      if (signal.aborted) throw new Error("cancelled");
      return result;
    } finally {
      // The network guard wakes a stalled request immediately. Native signature
      // verification must still finish killing its process tree before shutdown,
      // or before a later operation can reuse the updater's shared mutable state.
      await pending?.catch(() => {});
      signal.removeEventListener("abort", abort);
      activeOperation = undefined;
      operationSignal = undefined;
    }
  }
  async function verify(signal: AbortSignal): Promise<void> {
    if (!selected || !downloaded || !isAbsolute(downloaded)) throw new Error("updateFailed");
    const before = await lstat(downloaded, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size !== BigInt(selected.size) ||
      (await realpath(downloaded)).toLowerCase() !== resolve(downloaded).toLowerCase()
    )
      throw new Error("updateFailed");
    const hash = createHash("sha512");
    for await (const bytes of createReadStream(downloaded, { highWaterMark: 64 * 1024, signal }))
      hash.update(bytes);
    if (hash.digest("base64") !== selected.sha512) throw new Error("updateChecksumMismatch");
    // Pin the configured publisher even if generated app-update.yml were missing.
    await verifyInstallerSignature(downloaded, provider.publisherName, signal);
    const after = await lstat(downloaded, { bigint: true });
    if (
      signal.aborted ||
      !after.isFile() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("updateFailed");
  }
  return {
    check: (signal) =>
      withSignal(signal, maxMetadataBytes, async () => {
        const result = await updater.checkForUpdates();
        if (!result) throw new Error("updateFailed");
        selected = result.isUpdateAvailable ? updateAsset(result.updateInfo) : undefined;
        downloaded = undefined;
        return { available: result.isUpdateAvailable, version: result.updateInfo.version };
      }),
    download: async (signal) => {
      if (!selected) throw new Error("updateFailed");
      return withSignal(signal, selected.size, async () => {
        activeToken = new CancellationToken();
        try {
          const paths = await updater.downloadUpdate(activeToken);
          if (paths.length !== 1 || !paths[0]) throw new Error("updateFailed");
          downloaded = paths[0];
          await verify(signal);
        } catch (error) {
          downloaded = undefined;
          throw error;
        } finally {
          activeToken = undefined;
        }
      });
    },
    prepareInstall: (signal) => withSignal(signal, maxMetadataBytes, () => verify(signal)),
    install: () => {
      if (!downloaded) throw new Error("updateFailed");
      updater.quitAndInstall(true, false);
    },
    dispose: async () => {
      activeToken?.cancel();
      await network.closeAllConnections();
      await activeOperation?.catch(() => {});
    },
  };
}
