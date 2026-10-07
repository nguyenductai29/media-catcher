import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cloud, Database, Download, FolderOpen, Globe, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, Segmented, StatusBadge } from "@/components/app/primitives";
import { LangSwitch } from "@/components/app/AppShell";
import { useT } from "@/lib/i18n";
import { useDesktopAPI } from "@/hooks/use-desktop";
import { DownloadOptions } from "@/components/app/DownloadDialog";
import { useDesktopAction, useDesktopLibrary } from "@/hooks/use-desktop-collections";
import { useDesktopDrive, useDriveAccountActions } from "@/hooks/use-desktop-drive";
import { DriveAccountControls } from "@/components/app/DriveControls";
import { hasLocalFile } from "@/lib/drive-display";
import { formatBytes } from "@/lib/media-display";
import type {
  BinaryStatuses,
  BrowserSettings,
  DownloadSettings,
  DriveSettings,
  ErrorCode,
  Result,
} from "../../shared/models";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — MediaVault" },
      {
        name: "description",
        content: "Configure downloads, browser, Google Drive sync and storage in MediaVault.",
      },
      { property: "og:title", content: "Settings — MediaVault" },
      { property: "og:description", content: "Configure how MediaVault works for you." },
    ],
  }),
  component: SettingsPage,
});

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h2 className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-bold">
        <Icon className="size-4 text-primary" />
        {title}
      </h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-3">
      <span className="text-sm">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
function Toggle({ label, on = false }: { label: string; on?: boolean }) {
  return (
    <Row label={label}>
      <Switch aria-label={label} defaultChecked={on} disabled title={label} />
    </Row>
  );
}
function SettingsPage() {
  const { t } = useT();
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.settings")} />
      <div className="mt-5 grid max-w-5xl gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Section icon={Settings2} title={t("settings.general")}>
            <Row label={t("settings.language")}>
              <LangSwitch />
            </Row>
            <p className="px-5 py-3 text-xs text-muted-foreground">{t("common.comingSoon")}</p>
            <Toggle label={t("settings.startWin")} />
            <Toggle label={t("settings.tray")} />
            <Toggle label={t("settings.background")} />
            <Toggle label={t("settings.updates")} />
          </Section>
          <DownloadSettingsSection />
          <BinarySettingsSection />
        </div>
        <div className="space-y-4">
          <BrowserSettingsSection />
          <DriveSettingsSection />
          <StorageSection />
        </div>
      </div>
    </div>
  );
}

function BrowserSettingsSection() {
  const { t } = useT();
  const api = useDesktopAPI();
  const [draft, setDraft] = useState<BrowserSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.settings
      .get()
      .then((settings) => {
        if (!active) return;
        if (settings.ok) setDraft(settings.value);
        else setError(settings.error);
      })
      .catch(() => {
        if (active) setError("unavailable");
      });
    return () => {
      active = false;
    };
  }, [api]);
  const run = async (action: () => Promise<Result<BrowserSettings | void>>, successKey: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.error);
      else {
        if (result.value) setDraft(result.value);
        setNotice(successKey);
      }
    } catch {
      setError("unavailable");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section icon={Globe} title={t("settings.browser")}>
      {!api && (
        <p className="px-5 py-3 text-xs text-muted-foreground">{t("desktop.launchTitle")}</p>
      )}
      <Row label={t("settings.session")}>
        <Switch
          aria-label={t("settings.session")}
          checked={draft?.saveSession ?? false}
          disabled={!draft || busy}
          onCheckedChange={(saveSession) =>
            setDraft((current) => (current ? { ...current, saveSession } : current))
          }
        />
      </Row>
      <p className="px-5 py-3 text-xs text-muted-foreground">{t("desktop.sessionHint")}</p>
      <Row label={t("settings.homepage")}>
        <input
          aria-label={t("settings.homepage")}
          value={draft?.homepage ?? ""}
          disabled={!draft || busy}
          onChange={(event) =>
            setDraft((current) =>
              current ? { ...current, homepage: event.target.value } : current,
            )
          }
          className="h-8 w-52 rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
      </Row>
      <div className="flex flex-wrap gap-2 px-5 py-3">
        <Button
          size="sm"
          disabled={!api || !draft || busy || !draft.homepage.trim()}
          onClick={() => {
            if (api && draft)
              void run(
                () =>
                  api.settings.update({ homepage: draft.homepage, saveSession: draft.saveSession }),
                "desktop.saved",
              );
          }}
        >
          {t(busy ? "desktop.saving" : "desktop.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!api || busy}
          onClick={() => {
            if (api) void run(() => api.settings.clearCookies(), "desktop.clearedCookies");
          }}
        >
          {t("settings.clearCookies")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!api || busy}
          onClick={() => {
            if (api) void run(() => api.settings.clearBrowserData(), "desktop.clearedData");
          }}
        >
          {t("settings.clearData")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-5 py-3 text-xs text-destructive">
          {t(`desktop.errors.${error}`)}
        </p>
      )}
      {notice && (
        <p role="status" className="px-5 py-3 text-xs text-success">
          {t(notice)}
        </p>
      )}
    </Section>
  );
}

function DownloadSettingsSection() {
  const { t } = useT();
  const api = useDesktopAPI();
  const action = useDesktopAction();
  const [draft, setDraft] = useState<DownloadSettings | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.settings
      .getDownloads()
      .then((result) => {
        if (!active) return;
        if (result.ok) setDraft(result.value);
        else setError(result.error);
      })
      .catch(() => {
        if (active) setError("unavailable");
      });
    return () => {
      active = false;
    };
  }, [api]);
  const change = (patch: Partial<DownloadSettings>) => {
    setSaved(false);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const choose = async () => {
    if (!api) return;
    const result = await action.run(() => api.downloads.chooseDirectory());
    if (result?.ok && result.value) change({ directory: result.value });
  };
  const save = async () => {
    if (!api || !draft) return;
    setSaved(false);
    const result = await action.run(() => api.settings.updateDownloads(draft));
    if (result?.ok) {
      setDraft(result.value);
      setSaved(true);
      setError(null);
    }
  };
  return (
    <Section icon={Download} title={t("settings.downloads")}>
      {!api && (
        <p className="px-5 py-3 text-xs text-muted-foreground">{t("desktop.launchTitle")}</p>
      )}
      <div className="px-5 py-3">
        <p className="text-sm">{t("settings.folder")}</p>
        <div className="mt-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 break-all rounded-md border border-input bg-background p-2 font-mono text-xs">
            {draft?.directory || t(api ? "common.loading" : "desktop.unknown")}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!draft || action.busy}
            onClick={() => void choose()}
          >
            <FolderOpen />
            {t("common.browse")}
          </Button>
        </div>
      </div>
      <Row label={t("settings.concurrent")}>
        <Select
          value={String(draft?.concurrency ?? 1)}
          onValueChange={(value) => change({ concurrency: Number(value) })}
          disabled={!draft || action.busy}
        >
          <SelectTrigger
            aria-label={t("settings.concurrent")}
            className="h-8 min-w-36 bg-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 5].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <div className="space-y-3 px-5 py-3">
        <DownloadOptions
          quality={draft?.quality ?? "best"}
          container={draft?.container ?? "mp4"}
          selected
          disabled={!draft || action.busy}
          onQuality={(quality) => change({ quality })}
          onContainer={(container) => change({ container })}
        />
      </div>
      <Row label={t("settings.autoRetry")}>
        <Switch
          aria-label={t("settings.autoRetry")}
          checked={draft?.autoRetry ?? false}
          disabled={!draft || action.busy}
          onCheckedChange={(autoRetry) => change({ autoRetry })}
        />
      </Row>
      <div className="space-y-2 px-5 py-3">
        <Button size="sm" disabled={!draft || action.busy} onClick={() => void save()}>
          {t(action.busy ? "desktop.saving" : "settings.saveDownloads")}
        </Button>
        {(action.error || error) && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${action.error ?? error}`)}
          </p>
        )}
        {saved && (
          <p role="status" className="text-xs text-success">
            {t("settings.downloadSaved")}
          </p>
        )}
      </div>
    </Section>
  );
}
function BinarySettingsSection() {
  const { t } = useT();
  const api = useDesktopAPI();
  const [status, setStatus] = useState<BinaryStatuses | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    setChecking(true);
    void api.binaries
      .getStatus()
      .then((result) => {
        if (!active) return;
        if (result.ok) setStatus(result.value);
        else setError(result.error);
      })
      .catch(() => {
        if (active) setError("unavailable");
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const refresh = async () => {
    if (!api) return;
    setChecking(true);
    setError(null);
    try {
      const result = await api.binaries.getStatus();
      if (result.ok) setStatus(result.value);
      else setError(result.error);
    } catch {
      setError("unavailable");
    } finally {
      setChecking(false);
    }
  };
  return (
    <Section icon={Settings2} title={t("settings.binaries")}>
      {(["ytDlp", "ffmpeg", "ffprobe"] as const).map((key) => (
        <Row key={key} label={t(`settings.binary.${key}`)}>
          <span
            className={`text-xs ${status?.[key].state === "ready" ? "text-success" : "text-muted-foreground"}`}
          >
            {status
              ? t(`settings.binary.${status[key].state}`)
              : t(api ? "desktop.checking" : "desktop.analyzerMissing")}
            {status?.[key].version && ` · ${status[key].version}`}
          </span>
        </Row>
      ))}
      <div className="space-y-3 px-5 py-3">
        <p className="text-xs text-muted-foreground">{t("settings.toolsHint")}</p>
        <Button
          size="sm"
          variant="outline"
          disabled={!api || checking}
          onClick={() => void refresh()}
        >
          {t(checking ? "desktop.checking" : "desktop.refreshStatus")}
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${error}`)}
          </p>
        )}
      </div>
    </Section>
  );
}
function StorageSection() {
  const { t, lang } = useT();
  const { items } = useDesktopLibrary();
  return (
    <Section icon={Database} title={t("settings.storage")}>
      <div className="px-5 py-4">
        <p className="text-xs text-muted-foreground">
          {t("desktop.librarySize", {
            size: formatBytes(
              items.filter(hasLocalFile).reduce((n, item) => n + item.fileSize, 0),
              lang,
              t("desktop.unknown"),
            ),
          })}
        </p>
      </div>
    </Section>
  );
}

function DriveSettingsSection() {
  const { t } = useT();
  const { api, state, loading, error } = useDesktopDrive();
  const action = useDesktopAction();
  const accountActions = useDriveAccountActions(api);
  const busy = action.busy || accountActions.busy;
  const [draft, setDraft] = useState<DriveSettings | null>(null);
  const dirty = useRef(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (api && !loading && !error && !dirty.current) setDraft(state.settings);
  }, [api, loading, error, state.settings]);
  const change = (patch: Partial<DriveSettings>) => {
    dirty.current = true;
    setSaved(false);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const save = async () => {
    if (!api || !draft) return;
    setSaved(false);
    const result = await action.run(() => api.settings.updateDrive(draft));
    if (result?.ok) {
      dirty.current = false;
      setDraft(result.value);
      setSaved(true);
    }
  };
  const errorCode =
    accountActions.error ?? action.error ?? error ?? state.error ?? state.account.error;
  return (
    <Section icon={Cloud} title={t("settings.drive")}>
      <div className="space-y-3 px-5 py-3">
        <p className="text-sm">
          {state.account.connected
            ? (state.account.email ?? state.account.displayName ?? t("status.connected"))
            : t("drive.notConnected")}
        </p>
        <p className="text-xs text-muted-foreground">
          {state.account.connected
            ? t("drive.rootFolder") +
              ": " +
              (state.account.rootFolderName ?? t("drive.unavailable"))
            : t(
                !api
                  ? "desktop.launchHint"
                  : !state.account.configured
                    ? "desktop.errors.driveNotConfigured"
                    : state.account.connecting
                      ? "drive.browserHint"
                      : "drive.connectHint",
              )}
        </p>
        <StatusBadge
          status={state.account.connected ? "uploaded" : "queued"}
          label={t(state.account.connected ? "status.connected" : "drive.notConnected")}
        />
        <DriveAccountControls
          state={state}
          available={!!api}
          busy={busy}
          disconnecting={accountActions.command === "disconnect"}
          onAction={(command) => void accountActions.run(command)}
        />
      </div>
      <Row label={t("settings.autoUpload")}>
        <Switch
          aria-label={t("settings.autoUpload")}
          checked={draft?.autoUpload ?? false}
          disabled={!api || !draft || busy}
          onCheckedChange={(autoUpload) => change({ autoUpload })}
        />
      </Row>
      <p className="px-5 py-3 text-xs text-muted-foreground">{t("settings.driveAutoHint")}</p>
      <Row label={t("settings.driveConcurrent")}>
        <Select
          value={String(draft?.concurrency ?? 2)}
          disabled={!api || !draft || busy}
          onValueChange={(value) => change({ concurrency: Number(value) })}
        >
          <SelectTrigger
            aria-label={t("settings.driveConcurrent")}
            className="h-8 min-w-20 bg-background"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <div className="space-y-2 px-5 py-3">
        <p className="text-sm">{t("settings.deleteAfter")}</p>
        <fieldset disabled={!api || !draft || busy} className="disabled:opacity-50">
          <Segmented
            value={draft?.deleteLocal ?? "never"}
            onChange={(value) => change({ deleteLocal: value as DriveSettings["deleteLocal"] })}
            items={[
              { value: "never", label: t("settings.never") },
              { value: "ask", label: t("settings.ask") },
              { value: "automatic", label: t("settings.auto") },
            ]}
          />
        </fieldset>
        <p className="text-xs text-muted-foreground">{t("settings.driveVerification")}</p>
      </div>
      <div className="space-y-2 px-5 py-3">
        <Button size="sm" disabled={!api || !draft || busy} onClick={() => void save()}>
          {t(busy ? "desktop.saving" : "settings.saveDrive")}
        </Button>
        {errorCode && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${errorCode}`)}
          </p>
        )}
        {saved && (
          <p role="status" className="text-xs text-success">
            {t("settings.driveSaved")}
          </p>
        )}
      </div>
    </Section>
  );
}
