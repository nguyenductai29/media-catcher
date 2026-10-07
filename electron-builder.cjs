const { version: electronVersion } = require("./node_modules/electron/package.json");
const updateProvider = require("./resources/update-provider.json");
const updatesConfigured = updateProvider?.provider === "github";
if (
  updatesConfigured
    ? Object.keys(updateProvider).sort().join(",") !== "owner,provider,publisherName,repo" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(updateProvider.owner) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(updateProvider.repo) ||
      typeof updateProvider.publisherName !== "string" ||
      !updateProvider.publisherName.trim() ||
      updateProvider.publisherName !== updateProvider.publisherName.trim() ||
      updateProvider.publisherName.length > 200 ||
      /\p{Cc}/u.test(updateProvider.publisherName)
    : updateProvider?.provider !== null || Object.keys(updateProvider).length !== 1
)
  throw new Error("Invalid public update-provider configuration.");

/** Local Windows builds only. Publishing and signing are separate explicit steps. */
module.exports = {
  appId: "com.mediavault.desktop",
  productName: "MediaVault",
  electronVersion,
  electronDist: "node_modules/electron/dist",
  directories: {
    app: "artifacts/package-app",
    output: "release",
    buildResources: "resources/branding",
  },
  files: [
    "dist-desktop/**",
    "dist-electron/*.cjs",
    "package.json",
    "packaging.json",
    "THIRD-PARTY-NOTICES.md",
    "node_modules/**",
  ],
  asar: true,
  asarUnpack: ["node_modules/better-sqlite3/prebuilds/*.node"],
  // better-sqlite3 13 ships a Node-API win32-x64 prebuild. Staging verifies it;
  // the packaged smoke actually loads it without changing development modules.
  npmRebuild: false,
  nodeGypRebuild: false,
  forceCodeSigning: updatesConfigured,
  compression: "normal",
  publish: updatesConfigured
    ? {
        provider: "github",
        owner: updateProvider.owner,
        repo: updateProvider.repo,
        private: false,
        releaseType: "release",
      }
    : null,
  extraResources: [
    { from: "artifacts/package-resources/bin", to: "bin" },
    { from: "artifacts/package-resources/branding", to: "branding" },
    { from: "artifacts/package-resources/notices", to: "notices" },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    executableName: "MediaVault",
    ...(updatesConfigured
      ? { signtoolOptions: { publisherName: updateProvider.publisherName } }
      : {}),
    // Preserve the exact upstream bytes covered by resources/notices/binaries.json.
    signExts: ["!yt-dlp.exe", "!ffmpeg.exe", "!ffprobe.exe"],
    icon: "resources/branding/icon.ico",
    requestedExecutionLevel: "asInvoker",
    artifactName: "MediaVault-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    packElevateHelper: false,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "MediaVault",
    installerIcon: "resources/branding/installer.ico",
    uninstallerIcon: "resources/branding/icon.ico",
  },
};
