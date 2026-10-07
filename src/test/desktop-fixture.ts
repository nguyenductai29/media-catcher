import type { MediaVaultAPI } from "../../shared/ipc-types";
import type { BrowserState } from "../../shared/models";

export const browserState: BrowserState = {
  url: "https://example.org/",
  title: "Example",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  scanning: false,
  media: [],
  analysis: null,
  error: null,
};

export function desktopFixture() {
  const listeners = new Set<(state: BrowserState) => void>();
  const success = async () => ({ ok: true as const, value: undefined });
  const api: MediaVaultAPI = {
    window: {
      minimize: success,
      close: success,
      maximize: async () => ({ ok: true, value: { maximized: true } }),
      getState: async () => ({ ok: true, value: { maximized: false } }),
      onState: () => () => {},
    },
    browser: {
      getState: async () => ({ ok: true, value: browserState }),
      open: success,
      back: success,
      forward: success,
      reload: success,
      stop: success,
      home: success,
      scan: success,
      setBounds: success,
      onState: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    settings: {
      get: async () => ({
        ok: true,
        value: { version: 1, homepage: "https://example.org/", saveSession: true },
      }),
      update: async (settings) => ({ ok: true, value: { ...settings, version: 1 } }),
      clearCookies: success,
      clearBrowserData: success,
    },
    binaries: {
      status: async () => ({ ok: true, value: { available: true, version: "2026.01.01" } }),
    },
  };
  return {
    api,
    listeners,
    emit: (state: BrowserState) => listeners.forEach((listener) => listener(state)),
  };
}
