import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Cloud, CloudOff, ExternalLink, HardDrive, Link2, Pause, RefreshCw, RotateCcw, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Bar, EmptyState, IconBtn, PageHeader, Segmented, StatusBadge, Thumb } from "@/components/app/primitives";
import { useT } from "@/lib/i18n";
import { driveItems, type DriveItem } from "@/lib/mock";

export const Route = createFileRoute("/drive")({
  head: () => ({
    meta: [
      { title: "Google Drive — MediaVault" },
      { name: "description", content: "Sync your MediaVault library to Google Drive and track uploads." },
      { property: "og:title", content: "Google Drive — MediaVault" },
      { property: "og:description", content: "Cloud backup and upload tracking for your media." },
    ],
  }),
  component: DrivePage,
});

type Tab = DriveItem["tab"];

function DrivePage() {
  const { t } = useT();
  const [connected, setConnected] = useState(true);
  const [tab, setTab] = useState<Tab>("uploading");
  const items = driveItems.filter((i) => i.tab === tab);

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.drive")} />
      <div className="panel mt-5 flex flex-wrap items-center gap-6 p-5">
        <div className="grid size-12 place-items-center rounded-xl bg-primary/10"><Cloud className="size-6 text-primary" /></div>
        <dl className="grid flex-1 grid-cols-3 gap-6 text-sm">
          <div><dt className="text-[11px] text-muted-foreground">{t("drive.account")}</dt><dd className="mt-0.5 font-medium">{connected ? "user@example.com" : "—"}</dd></div>
          <div><dt className="text-[11px] text-muted-foreground">{t("drive.status")}</dt><dd className="mt-1">{connected ? <StatusBadge status="completed" label={t("status.connected")} /> : <StatusBadge status="failed" label={t("drive.notConnected")} />}</dd></div>
          <div><dt className="text-[11px] text-muted-foreground">{t("drive.storage")}</dt><dd className="mt-0.5 font-mono text-xs">812 GB / 2 TB</dd><Bar value={40.6} className="mt-1.5" /></div>
        </dl>
        <div className="flex gap-2">
          {connected ? <>
            <Button size="sm" variant="ghost" onClick={() => setConnected(false)}><Unplug />{t("drive.disconnect")}</Button>
            <Button size="sm" variant="glow" onClick={() => toast.success(t("toast.synced"))}><RefreshCw />{t("drive.sync")}</Button>
          </> : <Button size="sm" variant="glow" onClick={() => setConnected(true)}><Link2 />{t("drive.connect")}</Button>}
        </div>
      </div>

      {!connected ? (
        <div className="panel mt-5"><EmptyState icon={CloudOff} title={t("drive.notConnected")} hint={t("drive.notConnectedHint")} action={<Button size="sm" variant="subtle" onClick={() => setConnected(true)}><Link2 />{t("drive.connect")}</Button>} /></div>
      ) : (
        <>
          <Segmented className="mt-5" value={tab} onChange={setTab} items={(["uploaded", "uploading", "local", "failed"] as Tab[]).map((v) => ({ value: v, label: t(`drive.tabs.${v}`), count: driveItems.filter((i) => i.tab === v).length }))} />
          <div className="mt-3 space-y-2">
            {items.length === 0 && <div className="panel"><EmptyState icon={Cloud} title={t("drive.empty")} /></div>}
            {items.map((i) => (
              <div key={i.id} className="panel flex items-center gap-4 p-3">
                <Thumb src={i.thumb} className="w-24 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{i.title}</p>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="font-mono">{i.size}</span>
                    <span className="flex items-center gap-1"><HardDrive className="size-3 text-success" />{t("drive.local")}</span>
                    <span className="flex items-center gap-1">{i.tab === "uploaded" ? <Cloud className="size-3 text-primary" /> : <CloudOff className="size-3" />}{t("drive.cloud")}</span>
                  </div>
                  {i.tab === "uploading" && (
                    <div className="mt-2 flex items-center gap-3">
                      <Bar value={i.progress ?? 0} status="uploading" className="flex-1" />
                      <span className="whitespace-nowrap font-mono text-[11px]">{i.done} / {i.size}</span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {i.tab === "uploading" && <><span className="mr-2 text-xs text-primary">{t("drive.uploadingPct", { n: i.progress ?? 0 })}</span><IconBtn icon={Pause} label={t("common.pause")} /><IconBtn icon={X} label={t("common.cancel")} /></>}
                  {i.tab === "uploaded" && <><StatusBadge status="uploaded" /><IconBtn icon={ExternalLink} label={t("common.openInDrive")} /></>}
                  {i.tab === "local" && <><StatusBadge status="localOnly" /><Button size="sm" variant="subtle" className="ml-1 h-7">{t("common.uploadDrive")}</Button></>}
                  {i.tab === "failed" && <><StatusBadge status="failed" /><Button size="sm" variant="subtle" className="ml-1 h-7"><RotateCcw />{t("common.retry")}</Button></>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
