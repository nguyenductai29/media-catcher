import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Film,
  FolderOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddUrlDialog } from "@/components/app/AddUrlDialog";
import { MediaPlayerDialog, type Playback } from "@/components/app/MediaPlayerDialog";
import {
  Bar,
  EmptyState,
  IconBtn,
  PageHeader,
  Segmented,
  StatusBadge,
} from "@/components/app/primitives";
import {
  useDesktopDownloads,
  useDesktopAction,
  useDesktopLibrary,
} from "@/hooks/use-desktop-collections";
import { useT } from "@/lib/i18n";
import { formatBytes, formatDuration, mediaHost } from "@/lib/media-display";
import { cn } from "@/lib/utils";
import type { DownloadJob, DownloadStatus } from "../../shared/models";

export const Route = createFileRoute("/downloads")({
  head: () => ({
    meta: [
      { title: "Downloads — MediaVault" },
      {
        name: "description",
        content: "Manage active, queued, paused and completed downloads in MediaVault.",
      },
      { property: "og:title", content: "Downloads — MediaVault" },
      { property: "og:description", content: "A professional download manager for your media." },
    ],
  }),
  component: DownloadsPage,
});

const activeStatuses: DownloadStatus[] = ["analyzing", "downloading", "processing"];
type Filter = "all" | "active" | "waiting" | "completed" | "failed";
const matches = (job: DownloadJob, filter: Filter) =>
  filter === "all" ||
  (filter === "active"
    ? activeStatuses.includes(job.status)
    : filter === "waiting"
      ? ["queued", "paused"].includes(job.status)
      : job.status === filter);

function DownloadsPage() {
  const { t, lang } = useT();
  const { api, items, loading, error } = useDesktopDownloads();
  const action = useDesktopAction();
  const { items: media } = useDesktopLibrary();
  const localAvailable = (job: DownloadJob) =>
    !media.some((item) => item.id === job.mediaId && item.localAvailable === false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [playback, setPlayback] = useState<Playback | null>(null);
  const stats = [
    { key: "active" as const, icon: Zap, cls: "text-primary" },
    { key: "waiting" as const, icon: Clock, cls: "text-warning" },
    { key: "completed" as const, icon: CheckCircle2, cls: "text-success" },
    { key: "failed" as const, icon: AlertTriangle, cls: "text-destructive" },
  ];
  const perform = (id: string, command: "pause" | "resume" | "cancel" | "retry" | "openFolder") => {
    if (
      api &&
      (command !== "openFolder" || items.some((job) => job.id === id && localAvailable(job)))
    )
      void action.run(() => api.downloads[command](id));
  };
  const play = async (job: DownloadJob) => {
    if (!api || !localAvailable(job)) return;
    const result = await action.run(() => api.downloads.play(job.id));
    if (result?.ok) setPlayback({ url: result.value, title: job.title, mediaId: job.mediaId });
  };
  const visible = items.filter((item) => matches(item, filter));
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t("downloads.title")}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={
                !api ||
                action.busy ||
                !items.some((i) => activeStatuses.includes(i.status) || i.status === "queued")
              }
              onClick={() => {
                if (api) void action.run(() => api.downloads.pauseAll());
              }}
            >
              <Pause />
              {t("downloads.pauseAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!api || action.busy || !items.some((i) => i.status === "paused")}
              onClick={() => {
                if (api) void action.run(() => api.downloads.resumeAll());
              }}
            >
              <Play />
              {t("downloads.resumeAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!api || action.busy || !items.some((i) => i.status === "completed")}
              onClick={() => {
                if (api) void action.run(() => api.downloads.clearCompleted());
              }}
            >
              <Trash2 />
              {t("downloads.clearCompleted")}
            </Button>
            <Button size="sm" variant="glow" onClick={() => setOpen(true)}>
              <Plus />
              {t("downloads.addUrl")}
            </Button>
          </>
        }
      />
      <div className="mt-5 grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <button
            key={s.key}
            aria-pressed={filter === s.key}
            onClick={() => setFilter(filter === s.key ? "all" : s.key)}
            className={cn(
              "panel flex items-center gap-3 p-4 text-left",
              filter === s.key && "border-primary/40",
            )}
          >
            <s.icon className={cn("size-5", s.cls)} />
            <div>
              <p className="text-2xl font-bold leading-none">
                {items.filter((i) => matches(i, s.key)).length}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t(`downloads.${s.key}`)}</p>
            </div>
          </button>
        ))}
      </div>
      <Segmented
        className="mt-4"
        value={filter}
        onChange={setFilter}
        items={(["all", "active", "waiting", "completed", "failed"] as Filter[]).map((value) => ({
          value,
          label: t(`downloads.${value}`),
        }))}
      />
      {(action.error || error) && (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {t(`desktop.errors.${action.error ?? error}`)}
        </p>
      )}
      {!api && <p className="mt-4 text-xs text-muted-foreground">{t("desktop.launchHint")}</p>}
      <div className="mt-5 space-y-2">
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("common.loading")}
          </p>
        ) : visible.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={Download}
              title={t("downloads.empty")}
              hint={t("downloads.emptyHint")}
              action={
                <Button size="sm" variant="subtle" onClick={() => setOpen(true)}>
                  <Plus />
                  {t("downloads.addUrl")}
                </Button>
              }
            />
          </div>
        ) : (
          visible.map((d) => {
            const pct = Math.round(Math.max(0, Math.min(100, d.progress)));
            const bytes = (value: number | undefined) =>
              formatBytes(value, lang, t("desktop.unknown"));
            return (
              <div
                key={d.id}
                className="panel group flex items-center gap-4 p-3 transition-colors hover:border-primary/20"
              >
                <div className="grid aspect-video w-28 shrink-0 place-items-center rounded-md bg-surface-2">
                  <Film className="size-8 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold">{d.title}</p>
                    <StatusBadge status={d.status} />
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {mediaHost(d.sourceUrl)} ·{" "}
                    <span className="font-mono">
                      {d.resolution} {d.formatLabel}{" "}
                      {d.quality === "audio"
                        ? t("downloadDialog.originalAudio")
                        : t(`downloadDialog.container.${d.container}`)}
                    </span>
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <Bar value={pct} status={d.status} className="flex-1" />
                    <span className="w-9 text-right font-mono text-[11px]">{pct}%</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-[11px] text-muted-foreground">
                    <span>
                      {bytes(d.downloadedBytes)} / {bytes(d.totalBytes)}
                    </span>
                    {d.status === "downloading" && (
                      <>
                        <span className="text-foreground">
                          {d.speed === undefined
                            ? t("desktop.unknown")
                            : t("downloads.speedValue", { value: bytes(d.speed) })}
                        </span>
                        <span>
                          {t("downloads.eta")} {formatDuration(d.eta)}
                        </span>
                      </>
                    )}
                    {d.error && (
                      <span className="font-sans text-destructive">
                        {t(`desktop.errors.${d.error}`)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {(activeStatuses.includes(d.status) || d.status === "queued") && (
                    <IconBtn
                      icon={Pause}
                      label={t("common.pause")}
                      disabled={action.busy}
                      onClick={() => perform(d.id, "pause")}
                    />
                  )}
                  {d.status === "paused" && (
                    <IconBtn
                      icon={Play}
                      label={t("common.resume")}
                      disabled={action.busy}
                      onClick={() => perform(d.id, "resume")}
                    />
                  )}
                  {(d.status === "failed" || d.status === "cancelled") && (
                    <IconBtn
                      icon={RotateCcw}
                      label={t("common.retry")}
                      disabled={action.busy}
                      onClick={() => perform(d.id, "retry")}
                    />
                  )}
                  {d.status === "completed" && (
                    <IconBtn
                      icon={Play}
                      label={t("common.play")}
                      disabled={action.busy || !localAvailable(d)}
                      onClick={() => void play(d)}
                    />
                  )}
                  <IconBtn
                    icon={FolderOpen}
                    label={t("common.openFolder")}
                    disabled={
                      action.busy || d.status !== "completed" || !d.outputPath || !localAvailable(d)
                    }
                    onClick={() => perform(d.id, "openFolder")}
                  />
                  {!["completed", "cancelled", "failed"].includes(d.status) && (
                    <IconBtn
                      icon={X}
                      label={t("common.cancel")}
                      disabled={action.busy}
                      onClick={() => perform(d.id, "cancel")}
                      className="hover:text-destructive"
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      <AddUrlDialog open={open} onOpenChange={setOpen} />
      <MediaPlayerDialog
        playback={playback}
        error={action.error}
        onClose={() => setPlayback(null)}
        onExternal={(id) => {
          if (api) void action.run(() => api.library.openExternal(id));
        }}
      />
    </div>
  );
}
