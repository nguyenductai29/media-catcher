import type { StorageService } from "../services/storage-service";
import type { RegisterHandler } from "./register-local-media-ipc";

export type StorageIPCServices = Pick<StorageService, "get" | "clean" | "setFingerprintEnabled">;
export function registerStorageIPC(storage: StorageIPCServices, handle: RegisterHandler): void {
  handle("storage:get", () => storage.get());
  handle("storage:clean", (action) => {
    if (action !== "staleTemp" && action !== "oldLogs" && action !== "unusedThumbnails")
      throw new Error("invalidInput");
    return storage.clean(action);
  });
  handle("storage:setFingerprintEnabled", (enabled) => {
    if (typeof enabled !== "boolean") throw new Error("invalidInput");
    return storage.setFingerprintEnabled(enabled);
  });
}
