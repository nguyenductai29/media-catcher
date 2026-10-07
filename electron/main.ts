import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  nativeImage,
  clipboard,
} from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BrowserManager } from "./browser/browser-manager";
import { YtDlpService } from "./downloads/ytdlp-service";
import { BinaryService } from "./services/binary-service";
import { SettingsService } from "./services/settings-service";
import { registerIPC } from "./ipc/register-ipc";
import { openDatabaseWithRecovery } from "./database/open-database";
import { BrowserCookieBridge } from "./browser/browser-cookie-bridge";
import { StorageService } from "./services/storage-service";
import { DownloadRepository } from "./repositories/download-repository";
import { MediaRepository } from "./repositories/media-repository";
import { ActivityRepository } from "./repositories/activity-repository";
import { SettingsRepository } from "./repositories/settings-repository";
import { DownloadSettingsService } from "./services/download-settings-service";
import { ActivityService } from "./services/activity-service";
import { FFmpegService } from "./services/ffmpeg-service";
import { LibraryService } from "./library/library-service";
import { DownloadManager } from "./downloads/download-manager";
import { DownloadWorker } from "./downloads/download-worker";
import { nativeText } from "./services/native-i18n";
import { createAppProtocol } from "./services/app-protocol";
import { LocalLogger } from "./services/local-logger";
import { DriveUploadRepository } from "./repositories/drive-upload-repository";
import { DriveSettingsService } from "./services/drive-settings-service";
import { SecureStore } from "./drive/secure-store";
import { GoogleAuthService } from "./drive/google-auth-service";
import { GoogleDriveService } from "./drive/google-drive-service";
import { UploadWorker } from "./drive/upload-worker";
import { UploadManager } from "./drive/upload-manager";
import { DriveCoordinator } from "./drive/drive-coordinator";
import { ProductSettingsService } from "./services/product-settings-service";
import { TrayController } from "./services/tray-controller";
import { DesktopLifecycle } from "./services/desktop-lifecycle";
import { resolveStartupPaths } from "./services/startup-paths";
import { APP_USER_MODEL_ID, createWindowsLoginItem } from "./services/windows-login-item";
import { YtDlpUpdater } from "./services/ytdlp-updater";
import { AppUpdateService, parseUpdateProvider } from "./services/app-update-service";
import { createElectronAppUpdater } from "./services/electron-app-updater";
import { DiagnosticsService } from "./services/diagnostics-service";
import updateProviderConfiguration from "../resources/update-provider.json";
import bundledBinaryNotices from "../resources/notices/binaries.json";
import type { ProductRoute } from "../shared/models";

app.setName("MediaVault");
app.setAppUserModelId(APP_USER_MODEL_ID);
const startupPaths = (() => {
  try {
    const paths = resolveStartupPaths({
      argv: process.argv,
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      installDirectory: dirname(process.execPath),
      defaultUserData: join(app.getPath("appData"), "MediaVault"),
      defaultVideos: app.getPath("videos"),
      env: process.env,
    });
    mkdirSync(paths.userData, { recursive: true, mode: 0o700 });
    mkdirSync(paths.videos, { recursive: true });
    app.setPath("userData", paths.userData);
    app.setPath("videos", paths.videos);
    return paths;
  } catch {
    dialog.showErrorBox(
      "MediaVault",
      nativeText(
        Intl.DateTimeFormat().resolvedOptions().locale.startsWith("vi") ? "vi" : "en",
        "desktop.invalidStartupPaths",
      ),
    );
    process.exit(1);
  }
})();
const loginArguments = [
  "--background",
  `--user-data-dir=${startupPaths.userData}`,
  `--media-videos-dir=${startupPaths.videos}`,
];
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mediavault",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
let mainWindow: BrowserWindow | null = null;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      const rendererRoot = resolve(app.getAppPath(), "dist-desktop");
      const settings = new SettingsService(app.getPath("userData"));
      await settings.load();
      const binaries = new BinaryService({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        userDataPath: app.getPath("userData"),
      });
      const logger = new LocalLogger(app.getPath("userData"));
      const ytDlpUpdater = new YtDlpUpdater({
        userDataDirectory: app.getPath("userData"),
        binaries,
      });
      await ytDlpUpdater.initialize().catch(() => logger.error("update", "updateFailed"));
      const cookies = new BrowserCookieBridge({
        directory: join(app.getPath("userData"), "browser-cookie-temp"),
        onEvent: (event) => logger.browserEvent(event),
      });
      await cookies.initialize();
      const analyzer = new YtDlpService(binaries, cookies);
      const database = await openDatabaseWithRecovery(app.getPath("userData"), {
        choose: async ({ canRestore }) => {
          const t = (key: string) =>
            nativeText(app.getLocale().startsWith("vi") ? "vi" : "en", key);
          const choices = canRestore
            ? (["openFolder", "restore", "exit"] as const)
            : (["openFolder", "exit"] as const);
          const response = await dialog.showMessageBox({
            type: "error",
            title: t("databaseRecovery.title"),
            message: t("databaseRecovery.message"),
            buttons: choices.map((choice) =>
              t(choice === "exit" ? "common.exit" : `databaseRecovery.${choice}`),
            ),
            defaultId: choices.length - 1,
            cancelId: choices.length - 1,
            noLink: true,
          });
          return choices[response.response] ?? "exit";
        },
        openDataFolder: async (path) => {
          if (await shell.openPath(path)) throw new Error("fileAccessDenied");
        },
      });
      if (!database) {
        app.quit();
        return;
      }
      const product = new ProductSettingsService({
        repository: new SettingsRepository(database),
        establishedUse:
          existsSync(join(app.getPath("userData"), "browser-settings.json")) ||
          database.query(
            (db) =>
              !!db.prepare("SELECT 1 FROM media UNION ALL SELECT 1 FROM downloads LIMIT 1").get(),
          ),
        login: createWindowsLoginItem(app, {
          supported: process.platform === "win32" && app.isPackaged,
          executable: process.execPath,
          args: loginArguments,
        }),
      });
      const media = new MediaRepository(database);
      const downloadSettings = new DownloadSettingsService(
        new SettingsRepository(database),
        startupPaths.videos,
        [app.getAppPath(), process.resourcesPath, dirname(process.execPath)],
      );
      const activity = new ActivityService(new ActivityRepository(database));
      const storage = new StorageService({
        userDataDirectory: app.getPath("userData"),
        settings: downloadSettings,
        repository: new SettingsRepository(database),
        downloads: new DownloadRepository(database),
        media,
      });
      await storage.startupCleanup();
      const ffmpeg = new FFmpegService(binaries);
      const library = new LibraryService({
        database,
        media,
        ffmpeg,
        settings: downloadSettings,
        activity,
        fingerprintEnabled: () => storage.fingerprintEnabled(),
      });
      const drivePreferences = new DriveSettingsService(new SettingsRepository(database));
      const secureStore = new SecureStore(app.getPath("userData"), {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (value) => safeStorage.encryptString(value),
        decryptString: (value) => safeStorage.decryptString(value),
        ...(process.platform === "linux"
          ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() }
          : {}),
      });
      const auth = new GoogleAuthService({
        ...(process.env["GOOGLE_CLIENT_ID"] ? { clientId: process.env["GOOGLE_CLIENT_ID"] } : {}),
        ...(process.env["GOOGLE_CLIENT_SECRET"]
          ? { clientSecret: process.env["GOOGLE_CLIENT_SECRET"] }
          : {}),
        store: secureStore,
        openExternal: (url) => shell.openExternal(url),
        callbackMessage: () =>
          nativeText(downloadSettings.getLanguage(), "drive.authorizationReceived"),
      });
      const api = new GoogleDriveService({ auth });
      // Constructors restore state only; work starts after the coordinator is initialized below.
      const account = () => coordinator.getAccount();
      const uploads = new UploadManager({
        isOnline: () => net.isOnline(),
        database,
        uploads: new DriveUploadRepository(database),
        media,
        settings: drivePreferences,
        activity,
        account,
        library,
        executor: new UploadWorker({
          drive: api,
          store: secureStore,
          library,
          settings: drivePreferences,
          account,
        }),
        onLibraryChanged: () => library.events.notify(),
        onCompleted: (job, item) => coordinator.uploadCompleted(job, item),
        logError: (id, code) => logger.error("upload", code, id),
      });
      const coordinator: DriveCoordinator = new DriveCoordinator({
        auth,
        api,
        uploads,
        media,
        preferences: drivePreferences,
        settings: new SettingsRepository(database),
        library,
        activity,
        openExternal: (url) => shell.openExternal(url),
        askDelete: async (item, signal) => {
          if (!mainWindow || mainWindow.isDestroyed() || signal.aborted) return false;
          const t = (key: string) => nativeText(downloadSettings.getLanguage(), key);
          const answer = await dialog.showMessageBox(mainWindow, {
            type: "question",
            title: "MediaVault",
            message: t("drive.deleteAfterUploadConfirm"),
            detail: item.title,
            buttons: [t("common.keepFile"), t("common.deleteLocalFile")],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal,
          });
          return !signal.aborted && answer.response === 1;
        },
        onLibraryChanged: () => library.events.notify(),
        logError: (code, id) => logger.error("drive", code, id),
      });
      const downloads = new DownloadManager({
        isOnline: () => net.isOnline(),
        database,
        downloads: new DownloadRepository(database),
        media,
        settings: downloadSettings,
        activity,
        executor: new DownloadWorker(analyzer, ffmpeg, downloadSettings),
        prepareMedia: (job, file, signal) => library.prepareDownloadedMedia(job, file, signal),
        onLibraryChanged: () => library.events.notify(),
        onCompleted: (item) => coordinator.downloadCompleted(item),
        logError: (jobId, code) => logger.error("download", code, jobId),
      });
      let devURL: string | undefined;
      if (!app.isPackaged && process.env["MEDIAVAULT_DEV_URL"]) {
        const url = new URL(process.env["MEDIAVAULT_DEV_URL"]);
        if (url.origin !== "http://127.0.0.1:5174")
          throw new Error("Invalid desktop development origin");
        devURL = url.origin;
      }
      protocol.handle(
        "mediavault",
        createAppProtocol({
          rendererRoot,
          thumbnailDirectory: downloadSettings.thumbnailDirectory,
          trustedOrigin: devURL ?? "mediavault://app",
          library,
          fetchFile: (url, options) => net.fetch(url, options),
        }),
      );
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.on("will-download", (event) => event.preventDefault());
      mainWindow = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1100,
        minHeight: 680,
        frame: false,
        show: false,
        backgroundColor: "#0e1118",
        title: "MediaVault",
        icon: join(
          app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"),
          "branding",
          "icon.ico",
        ),
        webPreferences: {
          preload: join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          navigateOnDragDrop: false,
        },
      });
      const window = mainWindow;
      const browser = new BrowserManager(window, settings, analyzer, cookies);
      const showWindow = (route?: ProductRoute) => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (route) window.webContents.send("product:navigate", route);
      };
      const updateProvider = parseUpdateProvider(updateProviderConfiguration);
      let finishWithUpdate: (() => void) | undefined;
      const appUpdates = new AppUpdateService({
        currentVersion: app.getVersion(),
        configured:
          app.isPackaged &&
          process.platform === "win32" &&
          process.arch === "x64" &&
          updateProvider !== null,
        createAdapter: async () => {
          if (!updateProvider) throw new Error("updateNotConfigured");
          return createElectronAppUpdater(updateProvider);
        },
        installAfterDrain: async (action) => {
          finishWithUpdate = action;
          try {
            await lifecycle.exit();
            if (!lifecycle.isComplete()) throw new Error("cancelled");
          } finally {
            finishWithUpdate = undefined;
          }
        },
      });
      const diagnostics = new DiagnosticsService({
        logger,
        jobStatuses: () => ({ downloads: downloads.list(), uploads: uploads.list() }),
        userDataDirectory: app.getPath("userData"),
        protectedDirectories: [app.getAppPath(), process.resourcesPath, dirname(process.execPath)],
        snapshot: async () => {
          const productPreferences = product.get();
          const downloadPreferences = downloadSettings.get();
          const driveSettings = drivePreferences.get();
          const snapshot = {
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron,
            nodeVersion: process.versions.node,
            platform: process.platform,
            architecture: process.arch,
            schemaVersion: database.query((db) =>
              Number(db.pragma("user_version", { simple: true })),
            ),
            databasePath: join(app.getPath("userData"), "mediavault.db"),
            downloadFolder: downloadPreferences.directory,
            driveConnected: coordinator.getAccount().connected,
            browserSession: settings.get().saveSession
              ? ("persistent" as const)
              : ("temporary" as const),
            activeDownloads: downloads
              .list()
              .filter((job) =>
                ["queued", "analyzing", "downloading", "processing"].includes(job.status),
              ).length,
            activeUploads: uploads
              .list()
              .filter((job) =>
                ["queued", "preparing", "uploading", "finalizing"].includes(job.status),
              ).length,
            settings: {
              language: downloadSettings.getLanguage(),
              theme: productPreferences.theme,
              closeBehavior: productPreferences.closeBehavior,
              startWithWindows: productPreferences.startWithWindows,
              quality: downloadPreferences.quality,
              container: downloadPreferences.container,
              downloadConcurrency: downloadPreferences.concurrency,
              uploadConcurrency: driveSettings.concurrency,
              autoUpload: driveSettings.autoUpload,
              deleteLocal: driveSettings.deleteLocal,
            },
          };
          const [binaryStatuses, availableDiskSpace] = await Promise.all([
            binaries.getStatus(),
            statfs(downloadPreferences.directory, { bigint: true })
              .then((disk) =>
                Number(
                  disk.bavail * disk.bsize > BigInt(Number.MAX_SAFE_INTEGER)
                    ? BigInt(Number.MAX_SAFE_INTEGER)
                    : disk.bavail * disk.bsize,
                ),
              )
              .catch(() => null),
          ]);
          return { ...snapshot, binaries: binaryStatuses, availableDiskSpace };
        },
        chooseExportPath: async () => {
          const result = await dialog.showSaveDialog(window, {
            title: nativeText(downloadSettings.getLanguage(), "diagnostics.exportTitle"),
            defaultPath: join(
              app.getPath("documents"),
              `MediaVault-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
            ),
            filters: [
              {
                name: nativeText(downloadSettings.getLanguage(), "diagnostics.exportFilter"),
                extensions: ["json"],
              },
            ],
          });
          return result.canceled || !result.filePath ? null : result.filePath;
        },
        openPath: async (path) => {
          if (await shell.openPath(path)) throw new Error("diagnosticsFailed");
        },
        writeClipboard: (text) => clipboard.writeText(text),
      });
      const removeIPC = registerIPC(
        window,
        browser,
        settings,
        binaries,
        devURL ?? "mediavault://app",
        {
          downloads,
          library,
          downloadSettings,
          activity,
          logger,
          guardMedia: (id, action) => coordinator.withMediaLock(id, action),
          onLanguageChanged: () => refreshTray(),
        },
        coordinator,
        {
          settings: product,
          version: () => app.getVersion(),
          exit: () => {
            void lifecycle.exit();
          },
          isExiting: () => lifecycle.isExiting(),
        },
        storage,
        {
          ytDlp: ytDlpUpdater,
          app: appUpdates,
          ffmpegSource:
            bundledBinaryNotices.binaries.find((binary) => binary.file === "ffmpeg.exe")
              ?.buildSourceUrl ?? "https://www.gyan.dev/ffmpeg/builds/",
        },
        diagnostics,
      );
      void coordinator.initialize().catch(() => logger.error("drive", "driveUnavailable"));
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      window.webContents.on("before-input-event", (event, input) => {
        if (!app.isPackaged && input.key === "F12" && input.type === "keyDown") {
          event.preventDefault();
          window.webContents.toggleDevTools();
        }
        if ((input.control || input.meta) && ["+", "-", "=", "0"].includes(input.key))
          event.preventDefault();
      });
      const emitWindow = () => {
        if (!window.webContents.isDestroyed())
          window.webContents.send("window:changed", { maximized: window.isMaximized() });
      };
      window.on("maximize", emitWindow);
      window.on("unmaximize", emitWindow);
      const tray = new TrayController({
        adapter: {
          create: (path) => {
            const icon = nativeImage.createFromPath(path);
            if (icon.isEmpty()) throw new Error("unavailable");
            return new Tray(icon);
          },
          buildMenu: (template) => Menu.buildFromTemplate(template),
        },
        iconPath: join(
          app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"),
          "branding",
          "tray.png",
        ),
        t: (key, variables) => nativeText(downloadSettings.getLanguage(), key, variables),
        actions: {
          open: () => showWindow(),
          downloads: () => showWindow("/downloads"),
          settings: () => showWindow("/settings"),
          pauseDownloads: () => downloads.pauseAll(),
          resumeDownloads: () => downloads.resumeAll(),
          pauseUploads: () => coordinator.pauseAll(),
          resumeUploads: () => coordinator.resumeAll(),
          exit: () => lifecycle.exit(),
        },
        onAvailability: (available) => product.setTrayAvailable(available),
        onError: () => logger.error("startup", "unavailable"),
      });
      const refreshTray = () =>
        tray.refresh({
          activeDownloads: downloads
            .list()
            .filter((job) =>
              ["queued", "analyzing", "downloading", "processing"].includes(job.status),
            ).length,
          activeUploads: uploads
            .list()
            .filter((job) =>
              ["queued", "preparing", "uploading", "finalizing"].includes(job.status),
            ).length,
        });
      const traySubscriptions = [
        downloads.events.subscribe(refreshTray),
        uploads.events.subscribe(refreshTray),
      ];
      tray.create();
      refreshTray();
      const lifecycle: DesktopLifecycle = new DesktopLifecycle({
        closeBehavior: () => product.get().closeBehavior,
        trayAvailable: () => tray.isAvailable(),
        hide: () => window.hide(),
        show: () => showWindow(),
        hasActiveWork: () => downloads.hasActiveWork() || coordinator.hasActiveWork(),
        confirmExit: async () => {
          const t = (key: string) => nativeText(downloadSettings.getLanguage(), key);
          return (
            (
              await dialog.showMessageBox(window, {
                type: "question",
                title: "MediaVault",
                message: t("downloads.exitConfirm"),
                buttons: [t("common.cancel"), t("common.exit")],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              })
            ).response === 1
          );
        },
        drain: async () => {
          const results = await Promise.allSettled([
            coordinator.shutdown(),
            downloads.shutdown(),
            ytDlpUpdater.shutdown(),
            appUpdates.shutdown(),
            diagnostics.shutdown(),
            binaries.shutdown(),
          ]);
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure) throw failure.reason;
          await library.shutdown();
          await storage.shutdown();
          traySubscriptions.forEach((unsubscribe) => unsubscribe());
          tray.dispose();
          product.dispose();
          activity.dispose();
          await browser.dispose();
          removeIPC();
          database.close();
          await logger.flush();
        },
        finish: () => {
          window.destroy();
          try {
            finishWithUpdate?.();
          } finally {
            app.quit();
          }
        },
        failed: () => {
          logger.error("shutdown", "unavailable");
          showWindow();
        },
      });
      app.on("before-quit", (event) => {
        if (!lifecycle.isComplete()) {
          event.preventDefault();
          void lifecycle.exit();
        }
      });
      window.once("ready-to-show", () => {
        try {
          if (
            !process.argv.includes("--background") ||
            !tray.isAvailable() ||
            !product.get().firstLaunchCompleted
          )
            window.show();
        } catch {
          window.show();
        }
      });
      window.on("close", (event) => {
        if (lifecycle.isComplete()) return;
        event.preventDefault();
        void lifecycle.closeWindow();
      });
      window.on("closed", () => {
        mainWindow = null;
      });
      await window.loadURL(devURL ?? "mediavault://app/index.html");
    })
    .catch(() => {
      console.error("MediaVault failed to start. Check the desktop build and local settings.");
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
}
