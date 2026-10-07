import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import en from "@/locales/en.json";
import vi from "@/locales/vi.json";

// Lightweight i18n layer; API mirrors react-i18next (`t(key, vars)`) so it can be swapped later.
export type Lang = "en" | "vi";
const dictionaries: Record<Lang, unknown> = { en, vi };

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, vars?: Record<string, string | number>) => string };
const I18nContext = createContext<Ctx | null>(null);

function lookup(dict: unknown, key: string): string | undefined {
  const v = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), dict);
  return typeof v === "string" ? v : undefined;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const saved = localStorage.getItem("mv-lang");
    if (saved === "vi" || saved === "en") setLangState(saved);
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("mv-lang", l);
    document.documentElement.lang = l;
  }, []);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = lookup(dictionaries[lang], key) ?? lookup(dictionaries.en, key) ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useT must be used inside I18nProvider");
  return c;
}
