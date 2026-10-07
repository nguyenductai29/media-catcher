import type { YtDlpUpdateState } from "../../shared/models";
import type { AppUpdateService } from "../services/app-update-service";
import type { RegisterHandler } from "./register-local-media-ipc";

export interface MaintenanceIPCServices {
  ytDlp: {
    get(): Promise<YtDlpUpdateState>;
    check(): Promise<YtDlpUpdateState>;
    update(): Promise<YtDlpUpdateState>;
  };
  app: Pick<AppUpdateService, "get" | "check" | "download" | "install">;
  ffmpegSource: string;
}
export function registerMaintenanceIPC(
  services: MaintenanceIPCServices,
  handle: RegisterHandler,
): void {
  handle("maintenance:get", async () => ({
    ytDlp: await services.ytDlp.get(),
    app: services.app.get(),
    ffmpegSource: services.ffmpegSource,
  }));
  handle("maintenance:checkYtDlp", () => services.ytDlp.check());
  handle("maintenance:updateYtDlp", () => services.ytDlp.update());
  handle("maintenance:checkApp", () => services.app.check());
  handle("maintenance:downloadApp", () => services.app.download());
  handle("maintenance:installApp", () => services.app.install());
}
