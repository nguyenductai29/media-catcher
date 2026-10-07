import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/app/primitives";
import { useProductVersion } from "@/hooks/use-desktop-product";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — MediaVault" },
      {
        name: "description",
        content: "About MediaVault, the personal desktop media manager for Windows.",
      },
      { property: "og:title", content: "About — MediaVault" },
      { property: "og:description", content: "Browse, capture, organize and sync your media." },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
  const { t } = useT();
  const version = useProductVersion();
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="panel w-full max-w-md p-8 text-center">
        <LogoMark className="mx-auto size-16" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight">
          Media<span className="text-primary">Vault</span>
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("about.tagline")}</p>
        <dl className="mt-6 grid grid-cols-2 gap-2 text-left text-xs">
          <dt className="text-muted-foreground">{t("about.version")}</dt>
          <dd className="text-right font-mono">{version ?? t("desktop.unknown")}</dd>
        </dl>
        <Button variant="subtle" size="sm" className="mt-6" disabled title={t("common.comingSoon")}>
          <RefreshCw />
          {t("about.check")}
        </Button>
        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
          {t("about.credits")}
        </p>
      </div>
    </div>
  );
}
