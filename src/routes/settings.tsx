import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Cloud, Database, Download, FolderOpen, Globe, Languages, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bar, PageHeader, Segmented } from "@/components/app/primitives";
import { LangSwitch } from "@/components/app/AppShell";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — MediaVault" },
      { name: "description", content: "Configure downloads, browser, Google Drive sync and storage in MediaVault." },
      { property: "og:title", content: "Settings — MediaVault" },
      { property: "og:description", content: "Configure how MediaVault works for you." },
    ],
  }),
  component: SettingsPage,
});

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-bold"><Icon className="size-4 text-primary" />{title}</h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-6 px-5 py-3"><span className="text-sm">{label}</span><div className="flex shrink-0 items-center gap-2">{children}</div></div>;
}
function Toggle({ label, on = false }: { label: string; on?: boolean }) {
  return <Row label={label}><Switch defaultChecked={on} /></Row>;
}
function Pick({ value, options }: { value: string; options: { v: string; l: string }[] }) {
  return (
    <Select defaultValue={value}>
      <SelectTrigger className="h-8 min-w-36 bg-background"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function SettingsPage() {
  const { t } = useT();
  const [del, setDel] = useState("ask");
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.settings")} />
      <div className="mt-5 grid max-w-5xl gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Section icon={Settings2} title={t("settings.general")}>
            <Row label={t("settings.language")}><LangSwitch /></Row>
            <Toggle label={t("settings.startWin")} on />
            <Toggle label={t("settings.tray")} on />
            <Toggle label={t("settings.background")} />
            <Toggle label={t("settings.updates")} on />
          </Section>
          <Section icon={Download} title={t("settings.downloads")}>
            <div className="px-5 py-3">
              <p className="text-sm">{t("settings.folder")}</p>
              <div className="mt-2 flex gap-2">
                <div className="flex h-8 flex-1 items-center rounded-md border border-input bg-background px-3 font-mono text-xs">D:\MediaVault\Downloads</div>
                <Button size="sm" variant="outline"><FolderOpen />{t("common.browse")}</Button>
              </div>
            </div>
            <Row label={t("settings.concurrent")}><Pick value="2" options={["1", "2", "3", "4", "6"].map((v) => ({ v, l: v }))} /></Row>
            <Row label={t("settings.quality")}><Pick value="best" options={[{ v: "best", l: t("settings.best") }, { v: "1080", l: "1080p" }, { v: "720", l: "720p" }]} /></Row>
            <Row label={t("settings.resolution")}><Pick value="1080p" options={["2160p", "1440p", "1080p", "720p", "480p"].map((v) => ({ v, l: v }))} /></Row>
            <Row label={t("settings.format")}><Pick value="mp4" options={[{ v: "mp4", l: "MP4" }, { v: "mkv", l: "MKV" }, { v: "orig", l: t("settings.original") }]} /></Row>
            <Toggle label={t("settings.autoRetry")} on />
          </Section>
        </div>
        <div className="space-y-4">
          <Section icon={Globe} title={t("settings.browser")}>
            <Toggle label={t("settings.session")} on />
            <Toggle label={t("settings.cookies")} on />
            <Row label={t("settings.homepage")}><input defaultValue="https://example.com" className="h-8 w-52 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" /></Row>
            <div className="flex flex-wrap gap-2 px-5 py-3">
              <Button size="sm" variant="outline">{t("settings.clearCookies")}</Button>
              <Button size="sm" variant="danger">{t("settings.clearData")}</Button>
            </div>
          </Section>
          <Section icon={Cloud} title={t("settings.drive")}>
            <Toggle label={t("settings.autoUpload")} on />
            <Toggle label={t("settings.verify")} on />
            <Toggle label={t("settings.deleteAfter")} />
            <div className="px-5 py-3">
              <p className="mb-2 text-sm">{t("settings.deleteBehavior")}</p>
              <Segmented value={del} onChange={setDel} items={[{ value: "never", label: t("settings.never") }, { value: "ask", label: t("settings.ask") }, { value: "auto", label: t("settings.auto") }]} />
            </div>
          </Section>
          <Section icon={Database} title={t("settings.storage")}>
            <div className="space-y-4 px-5 py-4">
              <div><div className="flex justify-between text-xs"><span>{t("settings.localStorage")}</span><span className="font-mono text-muted-foreground">421 GB / 500 GB</span></div><Bar value={84} status="paused" className="mt-2" /></div>
              <div><div className="flex justify-between text-xs"><span>Google Drive</span><span className="font-mono text-muted-foreground">812 GB / 2 TB</span></div><Bar value={40.6} className="mt-2" /></div>
              <Button size="sm" variant="outline"><Languages className="hidden" />{t("settings.storageManager")}</Button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
