import type { BrowserWindow } from "electron";
import type { DriveCoordinator } from "../drive/drive-coordinator";
import { checkedId } from "./register-local-media-ipc";

export type DriveIPCServices = Pick<
  DriveCoordinator,
  | "getState"
  | "getAccount"
  | "connect"
  | "disconnect"
  | "sync"
  | "upload"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "open"
  | "getSettings"
  | "updateSettings"
  | "events"
>;
/** Uses the existing sender-validated Result<T> handler; every operation is explicit. */
export function registerDriveIPC(
  window: BrowserWindow,
  drive: DriveIPCServices,
  handle: (channel: string, action: (...args: unknown[]) => unknown) => void,
): () => void {
  handle("drive:getState", () => drive.getState());
  handle("drive:getAccount", () => drive.getAccount());
  handle("drive:connect", () => drive.connect());
  handle("drive:disconnect", () => drive.disconnect());
  handle("drive:sync", () => drive.sync());
  handle("drive:listUploads", () => drive.getState().uploads);
  handle("drive:upload", (id) => drive.upload(checkedId(id)));
  handle("drive:pause", (id) => drive.pause(checkedId(id)));
  handle("drive:resume", (id) => drive.resume(checkedId(id)));
  handle("drive:cancel", (id) => drive.cancel(checkedId(id)));
  handle("drive:retry", (id) => drive.retry(checkedId(id)));
  handle("drive:open", (id) => drive.open(checkedId(id)));
  handle("settings:getDrive", () => drive.getSettings());
  handle("settings:updateDrive", (input) => drive.updateSettings(input));
  return drive.events.subscribe((snapshot) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send("drive:changed", snapshot);
  });
}
