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
} from "electron";
import { isAbsolute, join, resolve } from "node:path";
import { BrowserManager } from "./browser/browser-manager";
import { YtDlpService } from "./downloads/ytdlp-service";
import { BinaryService } from "./services/binary-service";
import { SettingsService } from "./services/settings-service";
import { registerIPC } from "./ipc/register-ipc";
import { SqliteDatabase } from "./database/database";
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

app.setName("MediaVault");
if (
  !app.isPackaged &&
  process.env["MEDIAVAULT_USER_DATA"] &&
  isAbsolute(process.env["MEDIAVAULT_USER_DATA"])
)
  app.setPath("userData", process.env["MEDIAVAULT_USER_DATA"]);
else app.setPath("userData", join(app.getPath("appData"), "MediaVault"));
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
      });
      const analyzer = new YtDlpService(binaries);
      const logger = new LocalLogger(app.getPath("userData"));
      const database = new SqliteDatabase(app.getPath("userData"));
      const media = new MediaRepository(database);
      const videosOverride = !app.isPackaged ? process.env["MEDIAVAULT_VIDEOS_DIR"] : undefined;
      const videosDirectory =
        videosOverride && isAbsolute(videosOverride) ? videosOverride : app.getPath("videos");
      const downloadSettings = new DownloadSettingsService(
        new SettingsRepository(database),
        videosDirectory,
        [app.getAppPath(), process.resourcesPath],
      );
      const activity = new ActivityService(new ActivityRepository(database));
      const ffmpeg = new FFmpegService(binaries);
      const library = new LibraryService({
        database,
        media,
        ffmpeg,
        settings: downloadSettings,
        activity,
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
      const browser = new BrowserManager(window, settings, analyzer);
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
        },
        coordinator,
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
      window.once("ready-to-show", () => window.show());
      let closing = false;
      let canClose = false;
      window.on("close", (event) => {
        if (canClose) return;
        event.preventDefault();
        if (closing) return;
        closing = true;
        void (async () => {
          if (downloads.hasActiveWork() || coordinator.hasActiveWork()) {
            const t = (key: string) => nativeText(downloadSettings.getLanguage(), key);
            const answer = await dialog.showMessageBox(window, {
              type: "question",
              title: "MediaVault",
              message: t("downloads.exitConfirm"),
              buttons: [t("common.cancel"), t("common.exit")],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            if (answer.response !== 1) {
              closing = false;
              return;
            }
          }
          await Promise.all([coordinator.shutdown(), downloads.shutdown()]);
          await library.shutdown();
          activity.dispose();
          browser.dispose();
          removeIPC();
          database.close();
          await logger.flush();
          canClose = true;
          window.close();
        })().catch(() => {
          logger.error("shutdown", "unavailable");
          closing = false;
        });
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
