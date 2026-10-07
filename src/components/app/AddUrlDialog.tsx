import { useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/lib/i18n";
import { Segmented } from "./primitives";

export function AddUrlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useT();
  const [url, setUrl] = useState("https://example.com/video");
  const [quality, setQuality] = useState("best");
  const [container, setContainer] = useState("mp4");
  const [busy, setBusy] = useState(false);

  const analyze = () => {
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      onOpenChange(false);
      toast.success(t("addUrl.added"));
    }, 1200);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-border bg-popover">
        <DialogHeader><DialogTitle>{t("addUrl.title")}</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-1 focus-within:ring-ring">
          <Link2 className="size-4 text-muted-foreground" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("addUrl.placeholder")} className="h-10 flex-1 bg-transparent font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground" />
        </div>
        <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t("addUrl.quality")}</p>
            <Segmented value={quality} onChange={setQuality} items={[{ value: "best", label: t("settings.best") }, ...["2160p", "1080p", "720p", "480p"].map((v) => ({ value: v, label: v }))]} />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t("addUrl.container")}</p>
            <Segmented value={container} onChange={setContainer} items={[{ value: "mp4", label: "MP4" }, { value: "mkv", label: "MKV" }, { value: "orig", label: t("settings.original") }]} />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox defaultChecked className="mt-0.5" />
            <span>{t("addUrl.autoUpload")}</span>
          </label>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("addUrl.openBrowser")}</Button>
          <Button variant="glow" onClick={analyze} disabled={busy || !url}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? t("addUrl.analyzing") : t("addUrl.analyze")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
