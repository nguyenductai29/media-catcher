import type { MediaVaultAPI } from "../../shared/ipc-types";
declare global {
  interface Window {
    mediaVault?: MediaVaultAPI;
  }
}
