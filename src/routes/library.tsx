import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Copy,
  FilePlus,
  Film,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  Library,
  List,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EmptyState,
  IconBtn,
  PageHeader,
  Segmented,
  StatusBadge,
} from "@/components/app/primitives";
import { MediaPlayerDialog, type Playback } from "@/components/app/MediaPlayerDialog";
import { useDesktopLibrary, useDesktopAction } from "@/hooks/use-desktop-collections";
import { useT } from "@/lib/i18n";
import { formatBytes, formatDuration, mediaHost, mediaThumbnail } from "@/lib/media-display";
import { cn } from "@/lib/utils";
import type { ImportSummary, MediaItem } from "../../shared/models";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Library — MediaVault" },
      {
        name: "description",
        content: "Browse, search and organize your local video library in MediaVault.",
      },
      { property: "og:title", content: "Library — MediaVault" },
      { property: "og:description", content: "Your personal, organized video library." },
    ],
  }),
  component: LibraryPage,
});

function LibraryPage() {
  const { t, lang } = useT();
  const { api, items, loading, error } = useDesktopLibrary();
  const action = useDesktopAction();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState("newest");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [notice, setNotice] = useState<ImportSummary | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const item = items.find((i) => i.id === selected) ?? null;
  const bytes = (size: number) => formatBytes(size, lang, t("desktop.unknown"));
  const date = (value: number) =>
    new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(value);
  const sourceName = (i: MediaItem) => mediaHost(i.sourceUrl) || t("library.localSource");
  const visible = items
    .filter(
      (i) =>
        (source === "all" || i.sourceType === source) &&
        i.title.toLocaleLowerCase(lang).includes(q.toLocaleLowerCase(lang)),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title, lang)
        : sort === "size"
          ? b.fileSize - a.fileSize
          : b.createdAt - a.createdAt,
    );
  const importMedia = async (folder: boolean) => {
    if (!api) return;
    setNotice(null);
    const result = await action.run(() =>
      folder ? api.library.addFolder(recursive) : api.library.addFile(),
    );
    if (result?.ok && (result.value.added || result.value.skipped || result.value.failed))
      setNotice(result.value);
  };
  const play = async (i: MediaItem) => {
    if (!api) return;
    const result = await action.run(() => api.library.play(i.id));
    if (result?.ok) setPlayback({ url: result.value, title: i.title, mediaId: i.id });
  };
  const reveal = (id: string) => {
    if (api) void action.run(() => api.library.openFolder(id));
  };
  const remove = (id: string, deleteFile: boolean) => {
    if (api)
      void action.run<boolean | void>(() =>
        deleteFile ? api.library.deleteFile(id) : api.library.remove(id),
      );
  };
  const metadata = (i: MediaItem) => [
    ["site", sourceName(i)],
    ["date", date(i.createdAt)],
    ["duration", formatDuration(i.duration)],
    ["resolution", i.resolution || t("desktop.unknown")],
    ["codec", i.videoCodec || t("desktop.unknown")],
    ["container", i.container.toUpperCase()],
    ["size", bytes(i.fileSize)],
    ["audio", i.audioCodec || t("desktop.unknown")],
    [
      "bitrate",
      i.bitrate
        ? t("desktop.kbps", {
            n: new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(i.bitrate / 1000),
          })
        : t("desktop.unknown"),
    ],
  ];
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t("nav.library")}
        subtitle={t("library.summary", {
          n: items.length,
          size: bytes(items.reduce((n, i) => n + i.fileSize, 0)),
        })}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!api || action.busy}
              onClick={() => void importMedia(false)}
            >
              <FilePlus />
              {t("library.addFile")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!api || action.busy}
              onClick={() => void importMedia(true)}
            >
              <FolderPlus />
              {t("library.addFolder")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!api || action.busy}
              onClick={() => {
                if (api) void action.run(() => api.library.refresh());
              }}
            >
              <RefreshCw className={action.busy ? "animate-spin" : ""} />
              {t("library.refresh")}
            </Button>
          </>
        }
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
            disabled={action.busy}
          />
          {t("library.recursive")}
        </label>
        {notice && (
          <p role="status">
            {t("library.importSummary", {
              added: notice.added,
              skipped: notice.skipped,
              failed: notice.failed,
            })}
          </p>
        )}
      </div>
      {(action.error || error) && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {t(`desktop.errors.${action.error ?? error}`)}
        </p>
      )}
      {!api && <p className="mt-3 text-xs text-muted-foreground">{t("desktop.launchHint")}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex h-9 w-72 items-center gap-2 rounded-lg border border-input bg-surface px-3 focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-4 text-muted-foreground" />
          <input
            aria-label={t("library.searchPh")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("library.searchPh")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger aria-label={t("common.sort")} className="h-9 w-auto min-w-36 bg-surface">
            <span className="text-muted-foreground">{t("common.sort")}:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t("library.sortNewest")}</SelectItem>
            <SelectItem value="name">{t("library.sortName")}</SelectItem>
            <SelectItem value="size">{t("library.sortSize")}</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex rounded-lg border border-border bg-chrome p-1">
          <IconBtn
            icon={LayoutGrid}
            label={t("library.grid")}
            active={view === "grid"}
            onClick={() => setView("grid")}
            className="size-7"
          />
          <IconBtn
            icon={List}
            label={t("library.list")}
            active={view === "list"}
            onClick={() => setView("list")}
            className="size-7"
          />
        </div>
      </div>
      <Segmented
        className="mt-3"
        value={source}
        onChange={setSource}
        items={["all", "download", "local"].map((value) => ({
          value,
          label: t(`library.sources.${value}`),
          count: items.filter((i) => value === "all" || i.sourceType === value).length,
        }))}
      />
      <div className="mt-5">
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("common.loading")}
          </p>
        ) : visible.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={Library}
              title={t("library.empty")}
              hint={t("library.emptyHint")}
              action={
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={!api || action.busy}
                  onClick={() => void importMedia(true)}
                >
                  <FolderPlus />
                  {t("library.addFolder")}
                </Button>
              }
            />
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
            {visible.map((i) => (
              <div
                key={i.id}
                className="panel group overflow-hidden transition-all hover:-translate-y-0.5 hover:border-primary/30"
              >
                <div className="relative">
                  <button
                    onClick={() => setSelected(i.id)}
                    className="block w-full"
                    aria-label={t("library.showDetails", { title: i.title })}
                  >
                    <MediaThumb item={i} />
                  </button>
                  <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] backdrop-blur">
                    {formatDuration(i.duration)}
                  </span>
                  <div className="absolute left-2 top-2 flex gap-1 rounded-lg bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <IconBtn
                      icon={Play}
                      label={t("common.play")}
                      disabled={action.busy}
                      onClick={() => void play(i)}
                    />
                    <IconBtn
                      icon={FolderOpen}
                      label={t("common.openFolder")}
                      disabled={action.busy}
                      onClick={() => reveal(i.id)}
                    />
                  </div>
                </div>
                <button className="block w-full p-3 text-left" onClick={() => setSelected(i.id)}>
                  <p className="truncate text-sm font-semibold">{i.title}</p>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="font-mono">
                      {i.resolution} · {bytes(i.fileSize)}
                    </span>
                    <HardDrive className="size-3.5 text-success" />
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {sourceName(i)} · {date(i.createdAt)}
                  </p>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  {["title", "duration", "resolution", "size", "source", "date", "storage"].map(
                    (key) => (
                      <th key={key} className="px-4 py-2.5 font-medium">
                        {t(`library.cols.${key}`)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {visible.map((i) => (
                  <tr
                    key={i.id}
                    className="border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2">
                      <button
                        onClick={() => setSelected(i.id)}
                        className="flex items-center gap-3 text-left font-medium"
                      >
                        <MediaThumb item={i} className="w-16" />
                        {i.title}
                      </button>
                    </td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">
                      {formatDuration(i.duration)}
                    </td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">{i.resolution}</td>
                    <td className="px-4 font-mono text-xs">{bytes(i.fileSize)}</td>
                    <td className="px-4 text-xs text-muted-foreground">{sourceName(i)}</td>
                    <td className="px-4 font-mono text-xs text-muted-foreground">
                      {date(i.createdAt)}
                    </td>
                    <td className="px-4">
                      <HardDrive
                        aria-label={t("library.localSource")}
                        className="size-3.5 text-success"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Sheet
        open={!!item && !playback}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-[420px] overflow-y-auto border-border bg-popover p-0 sm:max-w-[420px] [&>button]:hidden">
          {item && (
            <>
              <div className="relative">
                <MediaThumb item={item} />
                <div className="absolute right-2 top-2">
                  <IconBtn
                    icon={X}
                    label={t("common.close")}
                    onClick={() => setSelected(null)}
                    className="bg-background/70 backdrop-blur"
                  />
                </div>
              </div>
              <div className="p-5">
                <SheetDescription className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("details.title")}
                </SheetDescription>
                <SheetTitle className="mt-1 text-lg font-bold">{item.title}</SheetTitle>
                <div className="mt-2 flex gap-2">
                  <StatusBadge status="localOnly" />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    variant="glow"
                    size="sm"
                    disabled={action.busy}
                    onClick={() => void play(item)}
                  >
                    <Play />
                    {t("common.play")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={action.busy}
                    onClick={() => reveal(item.id)}
                  >
                    <FolderOpen />
                    {t("common.openFolder")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(item.localPath).catch(() => undefined);
                    }}
                  >
                    <Copy />
                    {t("common.copyPath")}
                  </Button>
                </div>
                <dl className="mt-5 space-y-2.5 text-xs">
                  {metadata(item).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{t(`details.${key}`)}</dt>
                      <dd className="truncate text-right font-mono">{value}</dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-muted-foreground">{t("details.path")}</dt>
                    <dd className="mt-1 break-all rounded-md bg-background p-2 font-mono text-[11px]">
                      {item.localPath}
                    </dd>
                  </div>
                </dl>
                {action.error && (
                  <p role="alert" className="mt-4 text-xs text-destructive">
                    {t(`desktop.errors.${action.error}`)}
                  </p>
                )}
                <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={action.busy}
                    onClick={() => remove(item.id, true)}
                  >
                    <Trash2 />
                    {t("common.deleteLocal")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={action.busy}
                    onClick={() => remove(item.id, false)}
                  >
                    <X />
                    {t("common.removeLibrary")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
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
function MediaThumb({ item, className }: { item: MediaItem; className?: string }) {
  const [failed, setFailed] = useState(false);
  return item.thumbnailPath && !failed ? (
    <img
      src={mediaThumbnail(item.id)}
      alt=""
      onError={() => setFailed(true)}
      loading="lazy"
      className={cn("aspect-video w-full object-cover", className)}
    />
  ) : (
    <div className={cn("grid aspect-video w-full place-items-center bg-surface-2", className)}>
      <Film className="size-8 text-muted-foreground" />
    </div>
  );
}
