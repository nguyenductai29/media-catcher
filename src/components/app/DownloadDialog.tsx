import { useEffect, useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDesktopAPI } from "@/hooks/use-desktop";
import { useDesktopAction } from "@/hooks/use-desktop-collections";
import { useT } from "@/lib/i18n";
import { formatBytes, mediaHost } from "@/lib/media-display";
import { sanitizeFilename } from "../../../shared/filenames";
import type {
  DetectedMedia,
  DownloadContainer,
  DownloadQuality,
  DownloadSettings,
  ErrorCode,
} from "../../../shared/models";

export function DownloadOptions({
  quality,
  container,
  onQuality,
  onContainer,
  disabled,
  selected = true,
}: {
  quality: DownloadQuality;
  container: DownloadContainer;
  onQuality: (quality: DownloadQuality) => void;
  onContainer: (container: DownloadContainer) => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { t } = useT();
  const qualities: DownloadQuality[] = [
    "best",
    ...(selected ? ["selected" as const] : []),
    "2160",
    "1440",
    "1080",
    "720",
    "480",
    "audio",
  ];
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{t("addUrl.quality")}</span>
        <Select
          value={quality}
          onValueChange={(v) => onQuality(v as DownloadQuality)}
          disabled={!!disabled}
        >
          <SelectTrigger aria-label={t("addUrl.quality")} className="h-8 w-48 bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {qualities.map((v) => (
              <SelectItem key={v} value={v}>
                {t(`downloadDialog.quality.${v}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm">{t("addUrl.container")}</span>
        <Select
          value={quality === "audio" ? "original" : container}
          onValueChange={(v) => onContainer(v as DownloadContainer)}
          disabled={disabled || quality === "audio"}
        >
          <SelectTrigger aria-label={t("addUrl.container")} className="h-8 w-48 bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["mp4", "mkv", "original"] as const).map((v) => (
              <SelectItem key={v} value={v}>
                {t(`downloadDialog.container.${v}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {quality === "audio" && (
        <p className="text-xs text-muted-foreground">{t("downloadDialog.audioHint")}</p>
      )}
    </>
  );
}

export function DownloadDialog({
  media,
  onClose,
}: {
  media: DetectedMedia | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!media}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg border-border bg-popover">
        {media && <DownloadForm key={media.id} media={media} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
function DownloadForm({ media, onClose }: { media: DetectedMedia; onClose: () => void }) {
  const { t, lang } = useT();
  const api = useDesktopAPI();
  const action = useDesktopAction();
  const [settings, setSettings] = useState<DownloadSettings | null>(null);
  const [loadError, setLoadError] = useState<ErrorCode | null>(null);
  const [title, setTitle] = useState(media.title || t("desktop.mediaTitle", { n: 1 }));
  const extension =
    settings?.quality === "audio" || settings?.container === "original"
      ? null
      : settings?.container;
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.settings
      .getDownloads()
      .then((result) => {
        if (!active) return;
        if (result.ok)
          setSettings({
            ...result.value,
            quality: media.type === "audio" ? "audio" : result.value.quality,
          });
        else setLoadError(result.error);
      })
      .catch(() => {
        if (active) setLoadError("unavailable");
      });
    return () => {
      active = false;
    };
  }, [api, media.type]);
  const choose = async () => {
    if (!api) return;
    const result = await action.run(() => api.downloads.chooseDirectory());
    if (result?.ok && result.value)
      setSettings((current) => (current ? { ...current, directory: result.value! } : current));
  };
  const submit = async () => {
    if (!api || !settings || !title.trim()) return;
    const result = await action.run(() =>
      api.downloads.add({
        mediaId: media.id,
        title: title.trim(),
        quality: settings.quality,
        container: settings.quality === "audio" ? "original" : settings.container,
        destinationDirectory: settings.directory,
      }),
    );
    if (result?.ok) {
      toast.success(t("toast.downloadQueued"));
      onClose();
    }
  };
  return (
    <>
      <DialogTitle>{t("downloadDialog.title")}</DialogTitle>
      <DialogDescription>{t("downloadDialog.hint")}</DialogDescription>
      <div className="space-y-4">
        <label className="block space-y-2 text-sm">
          <span>{t("downloadDialog.name")}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={action.busy}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <dl className="grid grid-cols-2 gap-2 rounded-lg bg-background p-3 text-xs">
          <dt className="text-muted-foreground">{t("details.site")}</dt>
          <dd className="truncate text-right">
            {mediaHost(media.sourcePageUrl) || mediaHost(media.url)}
          </dd>
          <dt className="text-muted-foreground">{t("desktop.format")}</dt>
          <dd className="text-right font-mono">
            {media.formatId || media.container || t("desktop.unknown")}
          </dd>
          <dt className="text-muted-foreground">{t("details.resolution")}</dt>
          <dd className="text-right font-mono">{media.resolution || t("desktop.unknown")}</dd>
          <dt className="text-muted-foreground">{t("browser.estSize")}</dt>
          <dd className="text-right font-mono">
            {formatBytes(media.estimatedSize, lang, t("desktop.unknown"))}
          </dd>
        </dl>
        <DownloadOptions
          quality={settings?.quality ?? "best"}
          container={settings?.container ?? "mp4"}
          disabled={!settings || action.busy}
          onQuality={(quality) =>
            setSettings((current) => (current ? { ...current, quality } : current))
          }
          onContainer={(container) =>
            setSettings((current) => (current ? { ...current, container } : current))
          }
        />
        <div className="rounded-md bg-background p-3 text-xs">
          <p className="text-muted-foreground">{t("downloadDialog.filename")}</p>
          <p className="mt-1 break-all font-mono">
            {sanitizeFilename(title)}
            {extension ? `.${extension}` : ` (${t("downloadDialog.originalExtension")})`}
          </p>
          <p className="mt-2 text-muted-foreground">{t("downloadDialog.filenameHint")}</p>
        </div>
        <div>
          <p className="text-sm">{t("downloadDialog.destination")}</p>
          <div className="mt-2 flex items-center gap-2">
            <p className="min-w-0 flex-1 break-all rounded-md border border-input bg-background p-2 font-mono text-xs">
              {settings?.directory || t("common.loading")}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!settings || action.busy}
              onClick={() => void choose()}
            >
              <FolderOpen />
              {t("common.browse")}
            </Button>
          </div>
        </div>
        {(action.error || loadError) && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${action.error ?? loadError}`)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="glow"
            disabled={!api || !settings || action.busy || !title.trim()}
            onClick={() => void submit()}
          >
            <Download />
            {t(action.busy ? "downloadDialog.queuing" : "downloadDialog.queue")}
          </Button>
        </div>
      </div>
    </>
  );
}
