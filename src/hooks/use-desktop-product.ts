import { useEffect, useState } from "react";
import type { ErrorCode, ProductPreferences, ProductSettings } from "../../shared/models";
import { useDesktopAPI } from "./use-desktop";

export const productPreferences = (settings: ProductSettings): ProductPreferences => ({
  closeBehavior: settings.closeBehavior,
  startWithWindows: settings.startWithWindows,
  theme: settings.theme,
});
export function useDesktopProduct() {
  const api = useDesktopAPI();
  const [settings, setSettings] = useState<ProductSettings | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let changed = false;
    const unsubscribe = api.product.onChanged((next) => {
      if (active) {
        changed = true;
        setSettings(next);
        setError(null);
      }
    });
    void api.settings
      .getProduct()
      .then((result) => {
        if (!active || changed) return;
        if (result.ok) setSettings(result.value);
        else setError(result.error);
      })
      .catch(() => {
        if (active && !changed) setError("productSettingsFailed");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);
  const accept = (next: ProductSettings) => {
    setSettings(next);
    setError(null);
  };
  return { api, settings, error, accept };
}
export function useProductVersion() {
  const api = useDesktopAPI();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.product
      .getVersion()
      .then((result) => {
        if (active && result.ok) setVersion(result.value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);
  return version;
}
export function useProductAppearance(theme: ProductPreferences["theme"]) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    const wasDark = root.classList.contains("dark");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      root.dataset["theme"] = dark ? "dark" : "light";
      root.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
      root.classList.toggle("dark", wasDark);
    };
  }, [theme]);
}
