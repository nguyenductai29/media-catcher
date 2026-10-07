import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Copy,
  ExternalLink,
  Upload,
  RotateCcw,
  FilePlus,
  FolderOpen,
  FolderPlus,
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
import { EmptyState, IconBtn, PageHeader, Segmented } from "@/components/app/primitives";
import { MediaAvailabilityBadges } from "@/components/app/DriveControls";
import { MediaThumbnail } from "@/components/app/MediaThumbnail";
import { useDesktopDrive } from "@/hooks/use-desktop-drive";
import {
  canOpenDrive,
  canRetryUpload,
  canUploadMedia,
  hasLocalFile,
  latestUpload,
} from "@/lib/drive-display";
import { MediaPlayerDialog, type Playback } from "@/components/app/MediaPlayerDialog";
import { useDesktopLibrary, useDesktopAction } from "@/hooks/use-desktop-collections";
import { useT } from "@/lib/i18n";
import { formatBytes, formatDuration, mediaHost } from "@/lib/media-display";
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
  const drive = useDesktopDrive();
  const [connectPrompt, setConnectPrompt] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState("newest");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [notice, setNotice] = useState<ImportSummary | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const item = items.find((i) => i.id === selected) ?? null;
  const selectedUpload = item
    ? latestUpload(item, drive.state.uploads, drive.state.account)
    : undefined;
  useEffect(() => {
    if (playback && items.some((i) => i.id === playback.mediaId && !hasLocalFile(i)))
      setPlayback(null);
  }, [items, playback]);
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
    if (!api || !hasLocalFile(i)) return;
    const result = await action.run(() => api.library.play(i.id));
    if (result?.ok) setPlayback({ url: result.value, title: i.title, mediaId: i.id });
  };
  const reveal = (id: string) => {
    if (api && items.some((i) => i.id === id && hasLocalFile(i)))
      void action.run(() => api.library.openFolder(id));
  };
  const remove = (id: string, deleteFile: boolean) => {
    if (api && (!deleteFile || items.some((i) => i.id === id && hasLocalFile(i))))
      void action.run<boolean | void>(() =>
        deleteFile ? api.library.deleteFile(id) : api.library.remove(id),
      );
  };
  const uploadMedia = (i: MediaItem) => {
    if (!api || !canUploadMedia(i, drive.state.account, drive.state.uploads)) return;
    if (!drive.state.account.connected) {
      setSelected(i.id);
      setConnectPrompt(true);
      return;
    }
    void action.run(() => api.drive.upload(i.id));
  };
  const retryUpload = (i: MediaItem) => {
    const job = latestUpload(i, drive.state.uploads, drive.state.account);
    if (api && job && canRetryUpload(i, job, drive.state.account))
      void action.run(() => api.drive.retry(job.id));
  };
  const openDrive = (i: MediaItem) => {
    if (api && canOpenDrive(i, drive.state.account)) void action.run(() => api.drive.open(i.id));
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
          size: bytes(items.filter(hasLocalFile).reduce((n, i) => n + i.fileSize, 0)),
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
      {(action.error || error || drive.error) && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {t(`desktop.errors.${action.error ?? error ?? drive.error}`)}
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
                    <MediaThumbnail item={i} />
                  </button>
                  <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] backdrop-blur">
                    {formatDuration(i.duration)}
                  </span>
                  <div className="absolute left-2 top-2 flex gap-1 rounded-lg bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <IconBtn
                      icon={Play}
                      label={t("common.play")}
                      disabled={action.busy || !hasLocalFile(i)}
                      onClick={() => void play(i)}
                    />
                    <IconBtn
                      icon={FolderOpen}
                      label={t("common.openFolder")}
                      disabled={action.busy || !hasLocalFile(i)}
                      onClick={() => reveal(i.id)}
                    />
                    <IconBtn
                      icon={Upload}
                      label={t("common.uploadDrive")}
                      disabled={
                        action.busy ||
                        !api ||
                        !canUploadMedia(i, drive.state.account, drive.state.uploads)
                      }
                      onClick={() => uploadMedia(i)}
                    />
                    <IconBtn
                      icon={ExternalLink}
                      label={t("common.openInDrive")}
                      disabled={action.busy || !api || !canOpenDrive(i, drive.state.account)}
                      onClick={() => openDrive(i)}
                    />
                    {latestUpload(i, drive.state.uploads, drive.state.account)?.status ===
                      "failed" && (
                      <IconBtn
                        icon={RotateCcw}
                        label={t("drive.retryUpload")}
                        disabled={
                          action.busy ||
                          !api ||
                          !canRetryUpload(
                            i,
                            latestUpload(i, drive.state.uploads, drive.state.account)!,
                            drive.state.account,
                          )
                        }
                        onClick={() => retryUpload(i)}
                      />
                    )}
                  </div>
                </div>
                <button className="block w-full p-3 text-left" onClick={() => setSelected(i.id)}>
                  <p className="truncate text-sm font-semibold">{i.title}</p>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="font-mono">
                      {i.resolution} · {bytes(i.fileSize)}
                    </span>
                  </div>
                  <div className="mt-2">
                    <MediaAvailabilityBadges
                      item={i}
                      account={drive.state.account}
                      upload={latestUpload(i, drive.state.uploads, drive.state.account)}
                    />
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
                        <MediaThumbnail item={i} className="w-16" />
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
                      <MediaAvailabilityBadges
                        item={i}
                        account={drive.state.account}
                        upload={latestUpload(i, drive.state.uploads, drive.state.account)}
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
                <MediaThumbnail item={item} />
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
                  <MediaAvailabilityBadges
                    item={item}
                    account={drive.state.account}
                    upload={selectedUpload}
                  />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button
                    variant="glow"
                    size="sm"
                    disabled={action.busy || !hasLocalFile(item)}
                    onClick={() => void play(item)}
                  >
                    <Play />
                    {t("common.play")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={action.busy || !hasLocalFile(item)}
                    onClick={() => reveal(item.id)}
                  >
                    <FolderOpen />
                    {t("common.openFolder")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasLocalFile(item)}
                    onClick={() => {
                      if (hasLocalFile(item))
                        void navigator.clipboard?.writeText(item.localPath).catch(() => undefined);
                    }}
                  >
                    <Copy />
                    {t("common.copyPath")}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={
                      action.busy ||
                      !api ||
                      !canUploadMedia(item, drive.state.account, drive.state.uploads)
                    }
                    onClick={() => uploadMedia(item)}
                  >
                    <Upload />
                    {t("common.uploadDrive")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy || !api || !canOpenDrive(item, drive.state.account)}
                    onClick={() => openDrive(item)}
                  >
                    <ExternalLink />
                    {t("common.openInDrive")}
                  </Button>
                  {selectedUpload?.status === "failed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        action.busy ||
                        !api ||
                        !canRetryUpload(item, selectedUpload, drive.state.account)
                      }
                      onClick={() => retryUpload(item)}
                    >
                      <RotateCcw />
                      {t("drive.retryUpload")}
                    </Button>
                  )}
                </div>
                {connectPrompt && !drive.state.account.connected && (
                  <div className="mt-3 rounded-lg border border-border bg-background p-3 text-xs">
                    <p className="text-muted-foreground">
                      {t(
                        drive.state.account.configured
                          ? "drive.connectHint"
                          : "desktop.errors.driveNotConfigured",
                      )}
                    </p>
                    <Button
                      className="mt-2"
                      size="sm"
                      disabled={
                        !api ||
                        action.busy ||
                        !drive.state.account.configured ||
                        drive.state.account.connecting
                      }
                      onClick={() => {
                        if (api) void action.run(() => api.drive.connect());
                      }}
                    >
                      {t(drive.state.account.connecting ? "drive.connecting" : "drive.connect")}
                    </Button>
                  </div>
                )}
                <dl className="mt-5 space-y-2.5 text-xs">
                  {metadata(item).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{t(`details.${key}`)}</dt>
                      <dd className="truncate text-right font-mono">{value}</dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-muted-foreground">{t("details.path")}</dt>
                    {!hasLocalFile(item) && (
                      <p className="mt-1 text-warning">{t("drive.localMissing")}</p>
                    )}
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
                    disabled={action.busy || !hasLocalFile(item)}
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
