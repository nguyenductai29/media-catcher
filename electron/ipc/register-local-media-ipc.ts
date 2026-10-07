import { dialog, shell, type BrowserWindow } from "electron";
import type { AddDownloadInput } from "../../shared/models";
import type { BrowserManager } from "../browser/browser-manager";
import type { DownloadManager } from "../downloads/download-manager";
import type { LibraryService } from "../library/library-service";
import type { DownloadSettingsService } from "../services/download-settings-service";
import type { ActivityService } from "../services/activity-service";
import { nativeText } from "../services/native-i18n";
import { validateOwnedFile } from "../downloads/download-files";
import type { LocalLogger } from "../services/local-logger";

export interface LocalMediaServices {
  downloads: DownloadManager;
  library: LibraryService;
  downloadSettings: DownloadSettingsService;
  activity: ActivityService;
  logger?: LocalLogger;
  guardMedia?<T>(id: string, action: () => T | Promise<T>): Promise<T>;
}
export type RegisterHandler = (channel: string, action: (...args: unknown[]) => unknown) => void;
export function checkedId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,100}$/i.test(value))
    throw new Error("invalidInput");
  return value;
}
export function registerLocalMediaIPC(
  window: BrowserWindow,
  browser: BrowserManager,
  services: LocalMediaServices,
  handle: RegisterHandler,
): () => void {
  const { downloads, library, downloadSettings, activity } = services;
  const guard = <T>(id: string, action: () => T | Promise<T>): T | Promise<T> =>
    services.guardMedia ? services.guardMedia(id, action) : action();
  const t = (key: string) => nativeText(downloadSettings.getLanguage(), key);
  let dialogOpen = false;
  const nativeDialog = async <T>(action: () => Promise<T>): Promise<T> => {
    if (dialogOpen || window.isDestroyed()) throw new Error("unavailable");
    dialogOpen = true;
    try {
      return await action();
    } finally {
      dialogOpen = false;
    }
  };
  const play = async (id: string) => {
    await library.validateKnownFile(id);
    return `mediavault://media/${encodeURIComponent(id)}/video`;
  };
  handle("settings:getDownloads", () => downloadSettings.get());
  handle("settings:updateDownloads", async (input) => {
    const value = await downloadSettings.update(input);
    downloads.settingsChanged();
    return value;
  });
  handle("settings:setLanguage", (language) => downloadSettings.setLanguage(language));
  handle("downloads:list", () => downloads.list());
  handle("downloads:add", (input) => {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !("mediaId" in input) ||
      typeof input.mediaId !== "string"
    )
      throw new Error("invalidInput");
    const candidate = browser.getState().media.find((media) => media.id === input.mediaId);
    if (!candidate) throw new Error("invalidInput");
    return downloads.add(input as AddDownloadInput, candidate);
  });
  handle("downloads:chooseDirectory", () =>
    nativeDialog(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: t("settings.folder"),
        defaultPath: downloadSettings.get().directory,
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled || !result.filePaths[0]
        ? null
        : downloadSettings.approveDirectory(result.filePaths[0]);
    }),
  );
  handle("downloads:pause", (id) => downloads.pause(checkedId(id)));
  handle("downloads:resume", (id) => downloads.resume(checkedId(id)));
  handle("downloads:cancel", (id) => downloads.cancel(checkedId(id)));
  handle("downloads:retry", (id) => downloads.retry(checkedId(id)));
  handle("downloads:pauseAll", () => downloads.pauseAll());
  handle("downloads:resumeAll", () => downloads.resumeAll());
  handle("downloads:clearCompleted", () => downloads.clearCompleted());
  handle("downloads:openFolder", async (id) => {
    const job = downloads.get(checkedId(id));
    if (job.status !== "completed" || !job.outputPath) throw new Error("fileMissing");
    shell.showItemInFolder(await validateOwnedFile(job.destinationDirectory, job.outputPath));
  });
  handle("downloads:play", (id) => {
    const job = downloads.get(checkedId(id));
    if (!job.mediaId) throw new Error("fileMissing");
    return play(job.mediaId);
  });
  handle("library:list", () => library.list());
  handle("library:addFile", () =>
    nativeDialog(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: t("library.addFile"),
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: t("nav.library"),
            extensions: [
              "mp4",
              "mkv",
              "webm",
              "mov",
              "avi",
              "m4v",
              "m4a",
              "mp3",
              "aac",
              "ogg",
              "opus",
              "flac",
              "wav",
            ],
          },
        ],
      });
      return library.importFiles(result.canceled ? [] : result.filePaths);
    }),
  );
  handle("library:addFolder", (recursive) => {
    if (typeof recursive !== "boolean") throw new Error("invalidInput");
    return nativeDialog(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: t("library.addFolder"),
        properties: ["openDirectory"],
      });
      return result.canceled || !result.filePaths[0]
        ? { added: 0, skipped: 0, failed: 0 }
        : library.importFolder(result.filePaths[0], recursive);
    });
  });
  handle("library:refresh", () => library.refresh());
  handle("library:remove", (id) => {
    const mediaId = checkedId(id);
    return guard(mediaId, () => library.remove(mediaId));
  });
  handle("library:deleteFile", (id) =>
    nativeDialog(async () => {
      const mediaId = checkedId(id);
      library.get(mediaId);
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        title: "MediaVault",
        message: t("library.deleteConfirm"),
        buttons: [t("common.cancel"), t("common.delete")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) return false;
      await guard(mediaId, () => library.deleteFile(mediaId));
      return true;
    }),
  );
  handle("library:openFolder", async (id) =>
    shell.showItemInFolder(await library.validateKnownFile(checkedId(id))),
  );
  handle("library:play", (id) => play(checkedId(id)));
  handle("library:openExternal", async (id) => {
    const failure = await shell.openPath(await library.validateKnownFile(checkedId(id)));
    if (failure) throw new Error("unsupportedFormat");
  });
  handle("activity:list", () => activity.list());
  const emit = (channel: string) => (snapshot: unknown) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, snapshot);
  };
  const subscriptions = [
    downloads.events.subscribe(emit("downloads:changed")),
    library.events.subscribe(emit("library:changed")),
    activity.events.subscribe(emit("activity:changed")),
  ];
  return () => subscriptions.forEach((unsubscribe) => unsubscribe());
}
