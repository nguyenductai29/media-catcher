import { app, BrowserWindow, Menu, net, protocol, session } from "electron";
import { isAbsolute, join, relative, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserManager } from "./browser/browser-manager";
import { YtDlpService } from "./downloads/ytdlp-service";
import { BinaryService } from "./services/binary-service";
import { SettingsService } from "./services/settings-service";
import { registerIPC } from "./ipc/register-ipc";

app.setName("MediaVault");
if (
  !app.isPackaged &&
  process.env["MEDIAVAULT_USER_DATA"] &&
  isAbsolute(process.env["MEDIAVAULT_USER_DATA"])
)
  app.setPath("userData", process.env["MEDIAVAULT_USER_DATA"]);
else app.setPath("userData", join(app.getPath("appData"), "MediaVault"));
protocol.registerSchemesAsPrivileged([
  { scheme: "mediavault", privileges: { standard: true, secure: true, supportFetchAPI: true } },
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
      protocol.handle("mediavault", (request) => {
        const url = new URL(request.url);
        if (url.host !== "app" || request.method !== "GET")
          return new Response(null, { status: 403 });
        let file: string;
        try {
          file = resolve(
            rendererRoot,
            `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
          );
        } catch {
          return new Response(null, { status: 400 });
        }
        const rel = relative(rendererRoot, file);
        if (isAbsolute(rel) || rel.startsWith("..") || !extname(file))
          return new Response(null, { status: 403 });
        return net.fetch(pathToFileURL(file).href);
      });
      const settings = new SettingsService(app.getPath("userData"));
      await settings.load();
      const binaries = new BinaryService({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      });
      const analyzer = new YtDlpService(binaries);
      let devURL: string | undefined;
      if (!app.isPackaged && process.env["MEDIAVAULT_DEV_URL"]) {
        const url = new URL(process.env["MEDIAVAULT_DEV_URL"]);
        if (url.origin !== "http://127.0.0.1:5174")
          throw new Error("Invalid desktop development origin");
        devURL = url.origin;
      }
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
      );
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
      window.on("close", () => {
        browser.dispose();
        removeIPC();
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
