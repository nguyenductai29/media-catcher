import { createFileRoute } from "@tanstack/react-router";
import { DownloadDialog } from "@/components/app/DownloadDialog";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Download,
  Film,
  Globe,
  Home,
  Lock,
  Monitor,
  PanelRight,
  Radar,
  RotateCw,
  Square,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, IconBtn, Segmented, StatusBadge } from "@/components/app/primitives";
import { useT } from "@/lib/i18n";
import { useDesktopBrowser, useDesktopViewport } from "@/hooks/use-desktop";
import type { DetectedMedia, ErrorCode, PageAnalysis, Result } from "../../shared/models";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Browser — MediaVault" },
      {
        name: "description",
        content: "Browse websites and inspect video and audio with MediaVault.",
      },
      { property: "og:title", content: "Browser — MediaVault" },
      { property: "og:description", content: "Browse websites and detect media streams." },
    ],
  }),
  component: BrowserPage,
});

type Tab = "all" | "video" | "audio" | "hls" | "direct";

function BrowserPage() {
  const { t } = useT();
  const { api, state, error } = useDesktopBrowser();
  const viewport = useRef<HTMLDivElement>(null);
  useDesktopViewport(viewport, api);
  const [url, setUrl] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [showPanel, setShowPanel] = useState(true);
  const [downloadMedia, setDownloadMedia] = useState<DetectedMedia | null>(null);
  const [actionError, setActionError] = useState<ErrorCode | null>(null);
  const latestAction = useRef(0);
  useEffect(() => {
    setUrl(state.url);
    setActionError(null);
  }, [state.url]);

  const run = async (action: () => Promise<Result<unknown>>) => {
    const id = ++latestAction.current;
    setActionError(null);
    try {
      const result = await action();
      if (id === latestAction.current && !result.ok) setActionError(result.error);
    } catch {
      if (id === latestAction.current) setActionError("unavailable");
    }
  };
  const open = () => {
    if (api && url.trim()) void run(() => api.browser.open(url));
  };
  const filtered = state.media.filter((media) => {
    if (tab === "all") return true;
    if (tab === "video")
      return media.type === "video" || media.type === "hls" || media.type === "dash";
    if (tab === "direct")
      return media.type === "direct" || media.type === "video" || media.type === "audio";
    return media.type === tab;
  });
  const displayedError = actionError ?? error ?? state.error;
  const stopping = state.loading || state.scanning;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-3 py-2">
        <IconBtn
          icon={ArrowLeft}
          label={t("browser.back")}
          disabled={!api || !state.canGoBack}
          onClick={() => {
            if (api) void run(() => api.browser.back());
          }}
        />
        <IconBtn
          icon={ArrowRight}
          label={t("browser.forward")}
          disabled={!api || !state.canGoForward}
          onClick={() => {
            if (api) void run(() => api.browser.forward());
          }}
        />
        <IconBtn
          icon={stopping ? Square : RotateCw}
          label={t(stopping ? "desktop.stop" : "browser.refresh")}
          disabled={!api}
          onClick={() => {
            if (api) void run(() => (stopping ? api.browser.stop() : api.browser.reload()));
          }}
        />
        <IconBtn
          icon={Home}
          label={t("browser.home")}
          disabled={!api}
          onClick={() => {
            if (api) void run(() => api.browser.home());
          }}
        />
        <form
          className="mx-2 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-1 focus:ring-ring"
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          {state.url.startsWith("https://") ? (
            <Lock className="size-3.5 shrink-0 text-success" />
          ) : (
            <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            aria-label={t("desktop.address")}
            placeholder={t("desktop.addressPlaceholder")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </form>
        <Button size="sm" variant="outline" onClick={open} disabled={!api || !url.trim()}>
          {t("browser.go")}
        </Button>
        <Button
          size="sm"
          variant="glow"
          className="ml-1"
          onClick={() => {
            if (api) void run(() => api.browser.scan());
          }}
          disabled={!api || state.scanning || state.loading || !state.url}
        >
          <Radar className={state.scanning ? "animate-spin" : ""} />
          {t("browser.scan")}
        </Button>
        <IconBtn
          icon={PanelRight}
          label={t(showPanel ? "desktop.hidePanel" : "desktop.showPanel")}
          active={showPanel}
          onClick={() => setShowPanel((shown) => !shown)}
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <section className="panel flex min-w-0 flex-[3] flex-col overflow-hidden">
          <div className="relative flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] text-muted-foreground">
            <Globe className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{state.title || t("browser.view")}</span>
            <span className="shrink-0">
              {state.loading ? t("browser.loading") : t(api ? "desktop.ready" : "desktop.preview")}
            </span>
            {state.loading && (
              <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                <div className="scan-line h-full w-1/2" />
              </div>
            )}
          </div>
          <div ref={viewport} data-browser-viewport className="min-h-0 flex-1 bg-background">
            {!api && (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={Monitor}
                  title={t("desktop.launchTitle")}
                  hint={t("desktop.launchHint")}
                />
              </div>
            )}
          </div>
        </section>

        {showPanel && (
          <aside className="panel flex w-[340px] min-w-[300px] flex-1 flex-col overflow-hidden">
            <div className="border-b border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold">{t("browser.detected")}</h2>
                <span className="text-[11px] text-muted-foreground">
                  {t("browser.sources", { n: state.media.length })}
                </span>
              </div>
              <Segmented
                className="mt-3"
                value={tab}
                onChange={setTab}
                items={(["all", "video", "audio", "hls", "direct"] as Tab[]).map((value) => ({
                  value,
                  label: t(`browser.tabs.${value}`),
                }))}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {displayedError && (
                <p
                  role="alert"
                  className="mb-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs text-destructive"
                >
                  {t(`desktop.errors.${displayedError}`)}
                </p>
              )}
              {state.scanning && (
                <div
                  role="status"
                  className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-primary"
                >
                  <Radar className="size-4 animate-spin" />
                  {t("desktop.analyzing")}
                </div>
              )}
              {state.analysis && <AnalysisSummary analysis={state.analysis} />}
              {filtered.length ? (
                <div className="space-y-2.5">
                  {filtered.map((media, index) => (
                    <MediaCard
                      key={media.id}
                      media={media}
                      index={index + 1}
                      onDownload={() => setDownloadMedia(media)}
                      disabled={!api || !!state.analysis?.drmProtected}
                    />
                  ))}
                </div>
              ) : (
                !state.scanning && (
                  <EmptyState
                    icon={Radar}
                    title={t("browser.noMedia")}
                    hint={t("desktop.browserHint")}
                  />
                )
              )}
            </div>
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {t("desktop.downloadReady")}
            </div>
          </aside>
        )}
      </div>
      <DownloadDialog media={downloadMedia} onClose={() => setDownloadMedia(null)} />
    </div>
  );
}

function AnalysisSummary({ analysis }: { analysis: PageAnalysis }) {
  const { t, lang } = useT();
  return (
    <section className="mb-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-primary">
        {t("desktop.analysisTitle")}
      </h3>
      <p className="mt-1 break-words text-sm font-semibold">{analysis.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {[analysis.uploader, analysis.website].filter(Boolean).join(" · ")}
      </p>
      <dl className="mt-3 space-y-1 text-[11px]">
        {analysis.duration !== undefined && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("details.duration")}</dt>
            <dd>
              {t("desktop.seconds", {
                n: new Intl.NumberFormat(lang).format(Math.round(analysis.duration)),
              })}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t("desktop.subtitles")}</dt>
          <dd className="min-w-0 break-words text-right">
            {analysis.subtitles.join(", ") || t("desktop.noSubtitles")}
          </dd>
        </div>
      </dl>
      {analysis.drmProtected && (
        <p className="mt-2 text-xs text-warning">{t("desktop.errors.drmProtected")}</p>
      )}
    </section>
  );
}

function MediaCard({
  media,
  index,
  onDownload,
  disabled,
}: {
  media: DetectedMedia;
  index: number;
  onDownload: () => void;
  disabled: boolean;
}) {
  const { t, lang } = useT();
  const Icon = media.type === "audio" ? AudioLines : Film;
  const host = (() => {
    try {
      return new URL(media.url).hostname;
    } catch {
      return t("desktop.unknown");
    }
  })();
  const size =
    media.estimatedSize === undefined
      ? t("desktop.unknown")
      : new Intl.NumberFormat(lang, {
          style: "unit",
          unit: "megabyte",
          maximumFractionDigits: 1,
        }).format(media.estimatedSize / 1_000_000);
  return (
    <div className="group rounded-lg border border-border bg-surface-2/50 p-3 transition-colors hover:border-primary/30 hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={media.title}>
            {media.title || t("desktop.mediaTitle", { n: index })}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{host}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[t(`desktop.mediaType.${media.type}`), media.resolution, media.codec]
              .filter(Boolean)
              .map((tag, i) => (
                <span
                  key={i}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
          </div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">{t("browser.output")}</dt>
        <dd className="text-right font-mono">
          {media.container?.toUpperCase() || t("desktop.unknown")}
        </dd>
        <dt className="text-muted-foreground">{t("browser.estSize")}</dt>
        <dd className="text-right font-mono">{size}</dd>
        {media.formatId && (
          <>
            <dt className="text-muted-foreground">{t("desktop.format")}</dt>
            <dd className="truncate text-right font-mono">{media.formatId}</dd>
          </>
        )}
        {media.bitrate !== undefined && (
          <>
            <dt className="text-muted-foreground">{t("desktop.bitrate")}</dt>
            <dd className="text-right font-mono">
              {t("desktop.kbps", {
                n: new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(media.bitrate),
              })}
            </dd>
          </>
        )}
      </dl>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge status="detected" />
          {media.hasAudio && (
            <Volume2 className="size-3.5 text-muted-foreground" aria-label={t("browser.audio")} />
          )}
        </div>
        <Button size="sm" variant="subtle" className="h-7" disabled={disabled} onClick={onDownload}>
          <Download />
          {t("common.download")}
        </Button>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        {t(`desktop.origin.${media.origin}`)}
      </p>
    </div>
  );
}
