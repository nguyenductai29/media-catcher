// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { APP_USER_MODEL_ID, createWindowsLoginItem } from "./windows-login-item";

const executable = "C:\\Apps Tiếng Việt 日本語\\MediaVault.exe";
const args = ["--background", "--user-data-dir=C:\\Profile Tiếng Việt 日本語"];
function setup(supported = true) {
  const state = {
    openAtLogin: true,
    executableWillLaunchAtLogin: true,
    launchItems: [{ name: APP_USER_MODEL_ID, scope: "user", enabled: true }],
  };
  const api = {
    getLoginItemSettings: vi.fn(() => state),
    setLoginItemSettings: vi.fn(),
  };
  return { state, api, login: createWindowsLoginItem(api, { supported, executable, args }) };
}

describe("Windows native login registration", () => {
  it("uses the AppUserModelId registry name and lets Electron quote raw arguments", () => {
    const { api, login } = setup();
    login.set(true);
    expect(api.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      enabled: true,
      path: executable,
      args,
      name: APP_USER_MODEL_ID,
    });
    login.set(false);
    expect(api.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: false,
      enabled: false,
      path: executable,
      args,
      name: APP_USER_MODEL_ID,
    });
  });
  it("quotes the lookup executable for Electron 44 paths containing spaces", () => {
    const { api, login } = setup();
    expect(login.get()).toBe(true);
    expect(api.getLoginItemSettings).toHaveBeenCalledWith({ path: `"${executable}"`, args });
  });
  it("does not report another enabled startup entry as enabling our disabled item", () => {
    const { state, login } = setup();
    state.launchItems = [
      { name: APP_USER_MODEL_ID, scope: "user", enabled: false },
      { name: "another-profile", scope: "user", enabled: true },
    ];
    expect(login.get()).toBe(false);
    state.launchItems = [{ name: APP_USER_MODEL_ID, scope: "machine", enabled: true }];
    expect(login.get()).toBe(false);
  });
  it("requires exact path and argument registration, and stays inactive in development", () => {
    const { state, login } = setup();
    state.openAtLogin = false;
    expect(login.get()).toBe(false);
    const unsupported = setup(false);
    expect(unsupported.login.get()).toBe(false);
    expect(() => unsupported.login.set(true)).toThrow("startupUnsupported");
    expect(unsupported.api.getLoginItemSettings).not.toHaveBeenCalled();
    expect(unsupported.api.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
