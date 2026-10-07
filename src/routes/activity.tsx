import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, History, Radar, UploadCloud } from "lucide-react";
import { EmptyState, PageHeader, Segmented } from "@/components/app/primitives";
import { useT } from "@/lib/i18n";
import { activity, type ActivityItem } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Activity — MediaVault" },
      { name: "description", content: "A timeline of downloads, uploads, detections and errors in MediaVault." },
      { property: "og:title", content: "Activity — MediaVault" },
      { property: "og:description", content: "Your MediaVault history at a glance." },
    ],
  }),
  component: ActivityPage,
});

type Tab = "all" | ActivityItem["kind"];
const toneCls = { success: "text-success bg-success/10", info: "text-info bg-info/10", error: "text-destructive bg-destructive/10", primary: "text-primary bg-primary/10" };
const iconFor = (a: ActivityItem) => (a.tone === "error" ? AlertTriangle : a.kind === "browser" ? Radar : a.kind === "uploads" ? UploadCloud : CheckCircle2);

function ActivityPage() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("all");
  const [empty, setEmpty] = useState(false);
  const items = empty ? [] : activity.filter((a) => tab === "all" || a.kind === tab);

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.activity")} />
      <Segmented className="mt-5" value={tab} onChange={setTab} items={(["all", "downloads", "uploads", "errors", "browser"] as Tab[]).map((v) => ({ value: v, label: t(`activity.tabs.${v}`) }))} />
      <div className="panel mt-4 max-w-3xl p-2">
        {items.length === 0 ? <EmptyState icon={History} title={t("activity.empty")} hint={t("activity.emptyHint")} /> :
          (["today", "yesterday"] as const).map((day) => {
            const group = items.filter((i) => i.day === day);
            if (!group.length) return null;
            return (
              <div key={day} className="p-2">
                <p className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t(`activity.${day}`)}</p>
                {group.map((a) => {
                  const Icon = iconFor(a);
                  return (
                    <div key={a.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                      <span className="w-12 font-mono text-xs text-muted-foreground">{a.time}</span>
                      <span className={cn("grid size-8 place-items-center rounded-lg", toneCls[a.tone])}><Icon className="size-4" /></span>
                      <span className="text-sm">{t(`activity.items.${a.key}`)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
      <div className="mt-4 max-w-3xl text-right"><button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setEmpty((e) => !e)}>{empty ? t("common.showData") : t("common.simulate")}</button></div>
    </div>
  );
}
