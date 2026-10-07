import { useEffect, useState, type RefObject } from "react";
import type { MediaVaultAPI } from "../../shared/ipc-types";
import type { BrowserState, ErrorCode, Result, ViewBounds, WindowState } from "../../shared/models";

const initialBrowserState: BrowserState = {
  url: "",
  title: "",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  scanning: false,
  media: [],
  analysis: null,
  error: null,
};

const initialWindowState: WindowState = { maximized: false };

// Resolve after mounting so the web build and its hydrated markup agree.
export function useDesktopAPI() {
  const [api, setAPI] = useState<MediaVaultAPI | null>(null);
  useEffect(() => {
    setAPI(window.mediaVault ?? null);
  }, []);
  return api;
}

type StateSource<T> = {
  getState(): Promise<Result<T>>;
  onState(listener: (state: T) => void): () => void;
};

function useDesktopState<T>(source: StateSource<T> | undefined, initial: T) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => {
    if (!source) return;
    let active = true;
    let receivedEvent = false;
    // Subscribe first; a snapshot started before navigation must not replace it.
    const unsubscribe = source.onState((next) => {
      if (!active) return;
      receivedEvent = true;
      setError(null);
      setState(next);
    });
    void source
      .getState()
      .then((result) => {
        if (!active || receivedEvent) return;
        if (result.ok) setState(result.value);
        else setError(result.error);
      })
      .catch(() => {
        if (active && !receivedEvent) setError("unavailable");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [source]);
  return { state, error };
}

export function useDesktopBrowser() {
  const api = useDesktopAPI();
  return { api, ...useDesktopState(api?.browser, initialBrowserState) };
}

export function useDesktopWindow() {
  const api = useDesktopAPI();
  return { api, ...useDesktopState(api?.window, initialWindowState) };
}

export function useDesktopViewport(ref: RefObject<HTMLElement | null>, api: MediaVaultAPI | null) {
  useEffect(() => {
    const element = ref.current;
    if (!api || !element) return;
    let frame = 0;
    let previous = "";
    const send = (bounds: ViewBounds | null) => {
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      void api.browser.setBounds(bounds).catch(() => undefined);
    };
    const measure = () => {
      frame = 0;
      // Portals cannot cover a native view. Keep it hidden through exit animations.
      if (
        document.hidden ||
        document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')
      ) {
        send(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));
      const width = Math.min(window.innerWidth, Math.round(rect.right)) - x;
      const height = Math.min(window.innerHeight, Math.round(rect.bottom)) - y;
      send(width > 0 && height > 0 ? { x, y, width, height } : null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["role", "open", "class", "style"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    measure();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void api.browser.setBounds(null).catch(() => undefined);
    };
  }, [api, ref]);
}
