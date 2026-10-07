import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { ErrorCode } from "../../../shared/models";

export type Playback = { url: string; title: string; mediaId?: string | undefined };
export function MediaPlayerDialog({
  playback,
  onClose,
  onExternal,
  error,
}: {
  playback: Playback | null;
  onClose: () => void;
  onExternal?: ((id: string) => void) | undefined;
  error?: ErrorCode | null;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={!!playback}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl border-border bg-popover">
        <DialogTitle>{playback?.title}</DialogTitle>
        <DialogDescription>{t("library.playerHint")}</DialogDescription>
        {playback && <Player key={playback.url} playback={playback} onExternal={onExternal} />}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${error}`)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
function Player({
  playback,
  onExternal,
}: {
  playback: Playback;
  onExternal?: ((id: string) => void) | undefined;
}) {
  const { t } = useT();
  const [failed, setFailed] = useState(false);
  return failed ? (
    <div className="space-y-4 rounded-lg bg-background p-8 text-center">
      <p role="alert" className="text-sm text-muted-foreground">
        {t("library.unsupportedPreview")}
      </p>
      {playback.mediaId && onExternal && (
        <Button variant="outline" onClick={() => onExternal(playback.mediaId!)}>
          <ExternalLink />
          {t("library.openExternal")}
        </Button>
      )}
    </div>
  ) : (
    <video
      className="max-h-[70vh] w-full rounded-lg bg-black"
      src={playback.url}
      controls
      autoPlay
      onError={() => setFailed(true)}
    />
  );
}
