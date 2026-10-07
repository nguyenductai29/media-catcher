import { createFileRoute } from "@tanstack/react-router";
import { Cloud, CloudOff, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, StatusBadge } from "@/components/app/primitives";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/drive")({
  head: () => ({
    meta: [
      { title: "Google Drive — MediaVault" },
      {
        name: "description",
        content: "Sync your MediaVault library to Google Drive and track uploads.",
      },
      { property: "og:title", content: "Google Drive — MediaVault" },
      { property: "og:description", content: "Cloud backup and upload tracking for your media." },
    ],
  }),
  component: DrivePage,
});

function DrivePage() {
  const { t } = useT();
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.drive")} />
      <div className="panel mt-5 flex flex-wrap items-center gap-6 p-5">
        <div className="grid size-12 place-items-center rounded-xl bg-primary/10">
          <Cloud className="size-6 text-primary" />
        </div>
        <dl className="grid flex-1 grid-cols-3 gap-6 text-sm">
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("drive.account")}</dt>
            <dd className="mt-0.5 font-medium">{t("desktop.unknown")}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("drive.status")}</dt>
            <dd className="mt-1">
              <StatusBadge status="queued" label={t("drive.notConnected")} />
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("drive.storage")}</dt>
            <dd className="mt-0.5 font-mono text-xs">{t("desktop.unknown")}</dd>
          </div>
        </dl>
        <Button size="sm" variant="glow" disabled>
          <Link2 />
          {t("drive.connect")}
        </Button>
      </div>
      <div className="panel mt-5">
        <EmptyState
          icon={CloudOff}
          title={t("drive.notConnected")}
          hint={t("drive.futureHint")}
          action={
            <Button size="sm" variant="subtle" disabled>
              <Link2 />
              {t("drive.connect")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
