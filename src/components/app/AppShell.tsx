import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, ChevronsLeft, ChevronsRight, Cloud, Download, Globe, HardDrive, Info, Library, Minus, Settings, Square, Wifi, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, type Lang } from "@/lib/i18n";
import { Logo } from "./primitives";

const mainNav = [
  { to: "/", key: "browser", icon: Globe },
  { to: "/downloads", key: "downloads", icon: Download, badge: 2 },
  { to: "/library", key: "library", icon: Library },
  { to: "/drive", key: "drive", icon: Cloud },
  { to: "/activity", key: "activity", icon: Activity },
] as const;
const bottomNav = [
  { to: "/settings", key: "settings", icon: Settings },
  { to: "/about", key: "about", icon: Info },
] as const;

export function LangSwitch() {
  const { lang, setLang } = useT();
  return (
    <div className="flex rounded-md border border-border bg-background p-0.5 text-[11px] font-bold">
      {(["en", "vi"] as Lang[]).map((l) => (
        <button key={l} onClick={() => setLang(l)} className={cn("rounded px-2 py-0.5 uppercase transition-colors", lang === l ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [collapsed, setCollapsed] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const current = [...mainNav, ...bottomNav].find((n) => (n.to === "/" ? path === "/" : path.startsWith(n.to)));

  const NavItem = ({ item }: { item: (typeof mainNav)[number] | (typeof bottomNav)[number] }) => {
    const active = item === current;
    const Icon = item.icon;
    return (
      <Link
        to={item.to}
        title={collapsed ? t(`nav.${item.key}`) : undefined}
        className={cn(
          "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
          active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        {active && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />}
        <Icon className={cn("size-[18px] shrink-0", active && "text-primary")} strokeWidth={1.75} />
        {!collapsed && <span className="truncate">{t(`nav.${item.key}`)}</span>}
        {!collapsed && "badge" in item && <span className="ml-auto rounded-full bg-primary/15 px-1.5 text-[10px] font-bold text-primary">{item.badge}</span>}
      </Link>
    );
  };

  return (
    <div className="flex h-screen min-w-[1100px] flex-col bg-chrome">
      {/* Title bar */}
      <header className="flex h-10 shrink-0 select-none items-center border-b border-border pl-4">
        <Logo />
        <span className="mx-3 h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">{current ? t(`nav.${current.key}`) : ""}</span>
        <div className="ml-auto flex items-center gap-3 pr-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Wifi className="size-3.5 text-success" />{t("common.online")}</span>
          <LangSwitch />
        </div>
        <div className="flex h-full">
          {[Minus, Square, X].map((I, i) => (
            <button key={i} aria-label={["Minimize", "Maximize", "Close"][i]} className={cn("grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground", i === 2 && "hover:bg-destructive hover:text-destructive-foreground")}>
              <I className={i === 1 ? "size-3" : "size-4"} />
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className={cn("flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 transition-[width] duration-200", collapsed ? "w-[60px]" : "w-[212px]")}>
          <nav className="flex flex-col gap-0.5">{mainNav.map((n) => <NavItem key={n.to} item={n} />)}</nav>
          <div className="mt-auto flex flex-col gap-0.5">
            {!collapsed && (
              <div className="mb-2 rounded-lg border border-border bg-surface p-3">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><HardDrive className="size-3.5" />D:\ 421 / 500 GB</div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full w-[84%] rounded-full bg-warning" /></div>
              </div>
            )}
            {bottomNav.map((n) => <NavItem key={n.to} item={n} />)}
            <button onClick={() => setCollapsed((c) => !c)} className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-[12px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground", collapsed && "justify-center px-0")}>
              {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" />{t("nav.collapse")}</>}
            </button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden bg-background">{children}</main>
      </div>

      {/* Status bar */}
      <footer className="flex h-7 shrink-0 items-center gap-5 border-t border-border px-4 font-mono text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-1.5 animate-pulse rounded-full bg-primary" />{t("statusbar.downloads", { n: 2 })}</span>
        <span>{t("statusbar.speed")}: <span className="text-foreground">24.8 MB/s</span></span>
        <span>{t("statusbar.storage")}: 421 GB / 500 GB</span>
        <span>{t("statusbar.drive")}: <span className="text-success">{t("status.connected")}</span></span>
        <span className="ml-auto">{t("statusbar.version")}: v0.1.0</span>
      </footer>
    </div>
  );
}
