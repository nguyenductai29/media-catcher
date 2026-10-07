import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Download, Film, Home, Lock, Play, Radar, RotateCw, Star, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, IconBtn, Segmented, StatusBadge } from "@/components/app/primitives";
import { useT } from "@/lib/i18n";
import { detectedMedia, thumbs, type DetectedMedia } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Browser — MediaVault" },
      { name: "description", content: "Browse websites and detect downloadable video and audio streams with MediaVault." },
      { property: "og:title", content: "Browser — MediaVault" },
      { property: "og:description", content: "Browse websites and detect downloadable media streams." },
    ],
  }),
  component: BrowserPage,
});

type Tab = "all" | "video" | "audio" | "hls" | "direct";
type PanelState = "results" | "scanning" | "empty";

function BrowserPage() {
  const { t } = useT();
  const [url, setUrl] = useState("https://example.com/watch/movie");
  const [loading, setLoading] = useState(false);
  const [starred, setStarred] = useState(false);
  const [panel, setPanel] = useState<PanelState>("results");
  const [tab, setTab] = useState<Tab>("all");

  const reload = () => { setLoading(true); setTimeout(() => setLoading(false), 1100); };
  const scan = () => {
    setPanel("scanning");
    setTimeout(() => { setPanel("results"); toast.success(t("toast.scanDone")); }, 2000);
  };

  const filtered = detectedMedia.filter((m) =>
    tab === "all" ? true : tab === "video" ? m.kind === "video" : tab === "audio" ? m.kind === "audio" : tab === "hls" ? m.type === "HLS" : m.direct,
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-3 py-2">
        <IconBtn icon={ArrowLeft} label={t("browser.back")} />
        <IconBtn icon={ArrowRight} label={t("browser.forward")} />
        <IconBtn icon={RotateCw} label={t("browser.refresh")} onClick={reload} className={loading ? "[&_svg]:animate-spin" : ""} />
        <IconBtn icon={Home} label={t("browser.home")} />
        <form className="mx-2 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-1 focus-within:ring-ring" onSubmit={(e) => { e.preventDefault(); reload(); }}>
          <Lock className="size-3.5 shrink-0 text-success" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none" />
          <button type="button" onClick={() => setStarred((s) => !s)} aria-label={t("browser.bookmark")} title={t("browser.bookmark")}>
            <Star className={cn("size-4", starred ? "fill-warning text-warning" : "text-muted-foreground hover:text-foreground")} />
          </button>
        </form>
        <Button size="sm" variant="outline" onClick={reload}>{t("browser.go")}</Button>
        <Button size="sm" variant="glow" className="ml-1" onClick={scan} disabled={panel === "scanning"}>
          <Radar className={panel === "scanning" ? "animate-spin" : ""} />{t("browser.scan")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {/* Browser view */}
        <section className="panel relative flex min-w-0 flex-[3] flex-col overflow-hidden">
          {loading && <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"><div className="scan-line h-full w-1/2" /></div>}
          <span className="absolute right-3 top-3 z-10 rounded bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">{t("browser.view")}</span>
          {loading ? <PageSkeleton label={t("browser.loading")} /> : <MockPage />}
        </section>

        {/* Detected media */}
        <aside className="panel flex w-[340px] min-w-[300px] flex-1 flex-col overflow-hidden">
          <div className="border-b border-border p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold">{t("browser.detected")}</h2>
              {panel === "results" && <span className="text-[11px] text-muted-foreground">{t("browser.sources", { n: detectedMedia.length })}</span>}
            </div>
            <Segmented className="mt-3" value={tab} onChange={setTab} items={(["all", "video", "audio", "hls", "direct"] as Tab[]).map((v) => ({ value: v, label: t(`browser.tabs.${v}`) }))} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {panel === "scanning" && <Scanning />}
            {panel === "empty" && <EmptyState icon={Radar} title={t("browser.noMedia")} hint={t("browser.noMediaHint")} action={<Button size="sm" variant="subtle" onClick={scan}><Radar />{t("browser.scan")}</Button>} />}
            {panel === "results" && (
              filtered.length ? <div className="space-y-2.5">{filtered.map((m, i) => <MediaCard key={m.id} m={m} index={i + 1} />)}</div>
                : <EmptyState icon={Radar} title={t("browser.noMedia")} hint={t("browser.noMediaHint")} />
            )}
          </div>
          <div className="border-t border-border px-3 py-2 text-right">
            <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setPanel(panel === "empty" ? "results" : "empty")}>
              {panel === "empty" ? t("common.showData") : t("common.simulate")}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MediaCard({ m, index }: { m: DetectedMedia; index: number }) {
  const { t } = useT();
  const [queued, setQueued] = useState(false);
  const Icon = m.kind === "audio" ? AudioLines : Film;
  return (
    <div className="group rounded-lg border border-border bg-surface-2/50 p-3 transition-colors hover:border-primary/30 hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Icon className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold">Media {index} <span className="font-mono text-[11px] font-normal text-muted-foreground">· {m.label}</span></p>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[m.type, m.resolution, m.quality].filter(Boolean).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{tag}</span>
            ))}
          </div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">{t("browser.output")}</dt><dd className="text-right font-mono">{m.output}</dd>
        <dt className="text-muted-foreground">{t("browser.estSize")}</dt><dd className="text-right font-mono">{m.size}</dd>
      </dl>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge status={queued ? "queued" : "detected"} />
          {m.audio && <Volume2 className="size-3.5 text-muted-foreground" aria-label={t("browser.audio")} />}
        </div>
        <Button size="sm" variant={queued ? "outline" : "subtle"} className="h-7" disabled={queued} onClick={() => { setQueued(true); toast(t("toast.downloadQueued"), { description: `Media ${index} · ${m.quality}` }); }}>
          <Download />{t("common.download")}
        </Button>
      </div>
    </div>
  );
}

function Scanning() {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <div className="relative grid size-16 place-items-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
        <span className="absolute inset-2 rounded-full border border-primary/40" />
        <Radar className="size-6 animate-spin text-primary" style={{ animationDuration: "2s" }} />
      </div>
      <p className="mt-5 text-sm font-medium">{t("browser.scanning")}</p>
      <div className="mt-4 w-48 overflow-hidden rounded-full bg-muted"><div className="scan-line h-1 w-1/2" /></div>
      <div className="mt-6 w-full space-y-2">{[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-2" />)}</div>
    </div>
  );
}

function PageSkeleton({ label }: { label: string }) {
  return (
    <div className="flex-1 space-y-4 p-6">
      <div className="h-6 w-1/3 animate-pulse rounded bg-surface-2" />
      <div className="aspect-video w-full animate-pulse rounded-lg bg-surface-2" />
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function MockPage() {
  const { t } = useT();
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-6 border-b border-border px-6 py-3 text-xs text-muted-foreground">
        <span className="font-bold text-foreground">example<span className="text-primary">.com</span></span>
        <span>Movies</span><span>Series</span><span>Docs</span>
      </div>
      <div className="grid gap-6 p-6 xl:grid-cols-[1fr_240px]">
        <div>
          <div className="group relative aspect-video overflow-hidden rounded-lg bg-chrome">
            <img src={thumbs.t1} alt="Neon Rain movie still" width={1088} height={608} className="size-full object-cover opacity-80" />
            <button className="absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-background/60 backdrop-blur transition-transform group-hover:scale-105" aria-label="Play">
              <Play className="ml-1 size-7 fill-foreground" />
            </button>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/90 to-transparent p-3">
              <div className="h-1 rounded-full bg-foreground/20"><div className="h-full w-[34%] rounded-full bg-primary" /></div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground"><span>0:34:12</span><span>2:04:51</span></div>
            </div>
          </div>
          <h3 className="mt-4 text-lg font-bold">Neon Rain (2026) — Full Movie</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("browser.views")}</p>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("browser.pageDesc")}</p>
        </div>
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">{t("browser.related")}</p>
          {[thumbs.t2, thumbs.t3, thumbs.t4].map((s, i) => (
            <div key={i} className="flex gap-2">
              <img src={s} alt="" loading="lazy" width={1088} height={608} className="aspect-video w-24 rounded object-cover" />
              <div className="space-y-1.5 pt-1"><div className="h-2 w-24 rounded bg-surface-2" /><div className="h-2 w-16 rounded bg-surface-2" /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
