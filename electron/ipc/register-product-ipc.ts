import type { BrowserWindow } from "electron";
import type { ProductSettingsService } from "../services/product-settings-service";
import type { RegisterHandler } from "./register-local-media-ipc";

export interface ProductIPCServices {
  settings: ProductSettingsService;
  version(): string;
  exit(): void;
  isExiting(): boolean;
}
export function registerProductIPC(
  window: BrowserWindow,
  product: ProductIPCServices,
  handle: RegisterHandler,
): () => void {
  handle("settings:getProduct", () => product.settings.get());
  handle("settings:updateProduct", (input) => product.settings.update(input));
  handle("settings:completeFirstLaunch", () => product.settings.completeFirstLaunch());
  handle("product:getVersion", () => product.version());
  handle("window:exit", () => {
    setImmediate(() => product.exit());
  });
  return product.settings.events.subscribe((settings) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send("product:changed", settings);
  });
}
