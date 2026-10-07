import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Link2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useDesktopAPI } from "@/hooks/use-desktop";
import type { ErrorCode } from "../../../shared/models";

export function AddUrlDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const api = useDesktopAPI();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => {
    if (open && api) void api.browser.setBounds(null).catch(() => undefined);
  }, [api, open]);

  const openBrowser = async (analyze: boolean) => {
    if (!api || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.browser.open(url);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      await navigate({ to: "/" });
      // Scan state and safe errors are published by main to the Browser page.
      if (analyze) void api.browser.scan().catch(() => undefined);
    } catch {
      setError("unavailable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg border-border bg-popover">
        <DialogHeader>
          <DialogTitle>{t("addUrl.title")}</DialogTitle>
          <DialogDescription>{t("desktop.analysisHint")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void openBrowser(true);
          }}
          className="space-y-4"
        >
          <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-1 focus-within:ring-ring">
            <Link2 className="size-4 text-muted-foreground" />
            <input
              aria-label={t("desktop.address")}
              value={url}
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t("addUrl.placeholder")}
              className="h-10 min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
            />
          </div>
          {!api && (
            <p className="rounded-lg border border-border bg-surface p-4 text-xs text-muted-foreground">
              {t("desktop.launchTitle")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t(`desktop.errors.${error}`)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!api || busy || !url.trim()}
              onClick={() => void openBrowser(false)}
            >
              {t("addUrl.openBrowser")}
            </Button>
            <Button type="submit" variant="glow" disabled={!api || busy || !url.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? t("addUrl.analyzing") : t("addUrl.analyze")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
