import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, FolderOpen, Pause, Play, Plus, RotateCcw, Trash2, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddUrlDialog } from "@/components/app/AddUrlDialog";
import { Bar, EmptyState, IconBtn, PageHeader, StatusBadge, Thumb } from "@/components/app/primitives";
import { useT } from "@/lib/i18n";
import { downloads as seed, type DownloadItem, type StatusKey } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/downloads")({
  head: () => ({
    meta: [
      { title: "Downloads — MediaVault" },
      { name: "description", content: "Manage active, queued, paused and completed downloads in MediaVault." },
      { property: "og:title", content: "Downloads — MediaVault" },
      { property: "og:description", content: "A professional download manager for your media." },
    ],
  }),
  component: DownloadsPage,
});

function DownloadsPage() {
  const { t } = useT();
  const [items, setItems] = useState<DownloadItem[]>(seed);
  const [open, setOpen] = useState(false);
  const set = (id: string, status: StatusKey) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
  const count = (s: StatusKey[]) => items.filter((i) => s.includes(i.status)).length;

  const stats = [
    { label: t("downloads.active"), n: count(["downloading"]), icon: Zap, cls: "text-primary" },
    { label: t("downloads.waiting"), n: count(["queued", "paused"]), icon: Clock, cls: "text-warning" },
    { label: t("downloads.completed"), n: count(["completed"]), icon: CheckCircle2, cls: "text-success" },
    { label: t("downloads.failed"), n: count(["failed"]), icon: AlertTriangle, cls: "text-destructive" },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title={t("downloads.title")}
        actions={<>
          <Button size="sm" variant="ghost" onClick={() => setItems((xs) => xs.map((x) => x.status === "downloading" ? { ...x, status: "paused" } : x))}><Pause />{t("downloads.pauseAll")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setItems((xs) => xs.map((x) => x.status === "paused" ? { ...x, status: "downloading", speed: x.speed ?? "9.1 MB/s", eta: x.eta ?? "4m 02s" } : x))}><Play />{t("downloads.resumeAll")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setItems((xs) => xs.filter((x) => x.status !== "completed"))}><Trash2 />{t("downloads.clearCompleted")}</Button>
          <Button size="sm" variant="glow" onClick={() => setOpen(true)}><Plus />{t("downloads.addUrl")}</Button>
        </>}
      />
      <div className="mt-5 grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="panel flex items-center gap-3 p-4">
            <s.icon className={cn("size-5", s.cls)} />
            <div><p className="text-2xl font-bold leading-none">{s.n}</p><p className="mt-1 text-xs text-muted-foreground">{s.label}</p></div>
          </div>
        ))}
      </div>
      <div className="mt-5 space-y-2">
        {items.length === 0 && <div className="panel"><EmptyState icon={Download} title={t("downloads.empty")} hint={t("downloads.emptyHint")} action={<Button size="sm" variant="subtle" onClick={() => setOpen(true)}><Plus />{t("downloads.addUrl")}</Button>} /></div>}
        {items.map((d) => <Row key={d.id} d={d} set={set} remove={() => setItems((xs) => xs.filter((x) => x.id !== d.id))} />)}
      </div>
      <div className="mt-4 text-right">
        <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setItems(items.length ? [] : seed)}>{items.length ? t("common.simulate") : t("common.showData")}</button>
      </div>
      <AddUrlDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function Row({ d, set, remove }: { d: DownloadItem; set: (id: string, s: StatusKey) => void; remove: () => void }) {
  const { t } = useT();
  const pct = Math.round((d.done / d.total) * 100);
  return (
    <div className="panel group flex items-center gap-4 p-3 transition-colors hover:border-primary/20">
      <Thumb src={d.thumb} className="w-28 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{d.title}</p>
          <StatusBadge status={d.status} />
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{d.source} · <span className="font-mono">{d.resolution} {d.type}</span></p>
        <div className="mt-2 flex items-center gap-3">
          <Bar value={pct} status={d.status} className="flex-1" />
          <span className="w-9 text-right font-mono text-[11px]">{pct}%</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-[11px] text-muted-foreground">
          <span>{d.done.toFixed(1)} GB / {d.total.toFixed(1)} GB</span>
          {d.status === "downloading" && <><span className="text-foreground">{d.speed ?? "9.1 MB/s"}</span><span>{t("downloads.eta")} {d.eta ?? "4m 02s"}</span></>}
          {d.status === "failed" && <span className="font-sans text-destructive">{t("downloads.error")}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {d.status === "downloading" && <IconBtn icon={Pause} label={t("common.pause")} onClick={() => set(d.id, "paused")} />}
        {(d.status === "paused" || d.status === "queued") && <IconBtn icon={Play} label={t("common.resume")} onClick={() => set(d.id, "downloading")} />}
        {d.status === "failed" && <Button size="sm" variant="subtle" className="h-7" onClick={() => set(d.id, "downloading")}><RotateCcw />{t("common.retry")}</Button>}
        <IconBtn icon={FolderOpen} label={t("common.openFolder")} />
        {d.status !== "completed" && <IconBtn icon={X} label={t("common.cancel")} onClick={remove} className="hover:text-destructive" />}
      </div>
    </div>
  );
}
