import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Cloud, History, Library } from "lucide-react";
import { EmptyState, PageHeader, Segmented } from "@/components/app/primitives";
import { useDesktopActivity } from "@/hooks/use-desktop-collections";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Activity — MediaVault" },
      {
        name: "description",
        content: "A timeline of downloads, uploads, detections and errors in MediaVault.",
      },
      { property: "og:title", content: "Activity — MediaVault" },
      { property: "og:description", content: "Your MediaVault history at a glance." },
    ],
  }),
  component: ActivityPage,
});

const isUpload = (type: string) =>
  type.startsWith("drive") || type === "localFileDeletedAfterUpload";

function ActivityPage() {
  const { t, lang } = useT();
  const { api, items, loading, error } = useDesktopActivity();
  const [tab, setTab] = useState("all");
  const filtered = items
    .filter(
      (i) =>
        tab === "all" ||
        (tab === "errors"
          ? !!i.error || i.type === "downloadFailed" || i.type === "driveUploadFailed"
          : tab === "downloads"
            ? i.type.startsWith("download")
            : tab === "uploads"
              ? isUpload(i.type)
              : !i.type.startsWith("download") && !isUpload(i.type)),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const day = (timestamp: number) => new Date(timestamp).toDateString();
  const today = day(Date.now());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = day(yesterdayDate.getTime());
  const groups = new Map<string, typeof filtered>();
  for (const item of filtered) {
    const key = day(item.createdAt);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.activity")} />
      <Segmented
        className="mt-5"
        value={tab}
        onChange={setTab}
        items={["all", "downloads", "uploads", "library", "errors"].map((value) => ({
          value,
          label: t(`activity.tabs.${value}`),
        }))}
      />
      {error && (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {t(`desktop.errors.${error}`)}
        </p>
      )}
      {!api && <p className="mt-4 text-xs text-muted-foreground">{t("desktop.launchHint")}</p>}
      <div className="panel mt-4 max-w-3xl p-2">
        {loading ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t("common.loading")}
          </p>
        ) : !filtered.length ? (
          <EmptyState icon={History} title={t("activity.empty")} hint={t("activity.emptyHint")} />
        ) : (
          Array.from(groups, ([date, events]) => (
            <div key={date} className="p-2">
              <p className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {date === today
                  ? t("activity.today")
                  : date === yesterday
                    ? t("activity.yesterday")
                    : new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(
                        events[0]!.createdAt,
                      )}
              </p>
              {events.map((event) => {
                const failed =
                  !!event.error ||
                  event.type === "downloadFailed" ||
                  event.type === "driveUploadFailed";
                const Icon = failed
                  ? AlertTriangle
                  : event.type.startsWith("download")
                    ? CheckCircle2
                    : isUpload(event.type)
                      ? Cloud
                      : Library;
                return (
                  <div
                    key={event.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                      {new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(
                        event.createdAt,
                      )}
                    </span>
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-lg",
                        failed
                          ? "bg-destructive/10 text-destructive"
                          : "bg-success/10 text-success",
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="break-words text-sm">
                        {t(`activity.events.${event.type}`, { title: event.title })}
                      </p>
                      {event.error && (
                        <p className="mt-1 text-xs text-destructive">
                          {t(`desktop.errors.${event.error}`)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
