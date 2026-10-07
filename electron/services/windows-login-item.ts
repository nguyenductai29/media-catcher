import type { LoginItemAdapter } from "./product-settings-service";

export const APP_USER_MODEL_ID = "com.mediavault.desktop";
interface NativeLoginApi {
  getLoginItemSettings(options: { path: string; args: string[] }): {
    openAtLogin: boolean;
    launchItems: { name: string; scope: string; enabled: boolean }[];
  };
  setLoginItemSettings(options: {
    openAtLogin: boolean;
    enabled: boolean;
    path: string;
    args: string[];
    name: string;
  }): void;
}

/** Electron owns registry writes and Windows argument quoting. */
export function createWindowsLoginItem(
  api: NativeLoginApi,
  options: { supported: boolean; executable: string; args: readonly string[] },
): LoginItemAdapter {
  const args = [...options.args];
  return {
    supported: options.supported,
    get: () => {
      if (!options.supported) return false;
      // Electron 44 parses the lookup path as a command line. Surrounding quotes
      // work on 44 and on the corrected 45+ implementation (electron/electron#54364).
      const value = api.getLoginItemSettings({ path: `"${options.executable}"`, args });
      return (
        value.openAtLogin &&
        value.launchItems.some(
          (item) => item.name === APP_USER_MODEL_ID && item.scope === "user" && item.enabled,
        )
      );
    },
    set: (enabled) => {
      if (!options.supported) throw new Error("startupUnsupported");
      api.setLoginItemSettings({
        openAtLogin: enabled,
        enabled,
        path: options.executable,
        args,
        // openAtLogin reads this exact AppUserModelId value on Windows.
        name: APP_USER_MODEL_ID,
      });
    },
  };
}
