import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow } from "@/components/app/SettingsSection";
import { useT } from "@/lib/i18n";
import type { DesktopMaintenance } from "@/hooks/use-desktop-maintenance";
import type { ErrorCode } from "../../../shared/models";

export function YtDlpMaintenance({ maintenance }: { maintenance: DesktopMaintenance }) {
  const { t } = useT();
  const { api, snapshot, setSnapshot, loading } = maintenance;
  const state = snapshot?.ytDlp;
  const [operation, setOperation] = useState<"check" | "update" | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [updated, setUpdated] = useState(false);
  const pending = useRef(false);
  const busy = loading || Boolean(operation);
  const run = async (kind: "check" | "update") => {
    if (!api || pending.current || busy || !state?.supported || (kind === "update" && state.busy))
      return;
    pending.current = true;
    setOperation(kind);
    setError(null);
    setUpdated(false);
    try {
      const result = await (kind === "check"
        ? api.maintenance.checkYtDlp()
        : api.maintenance.updateYtDlp());
      if (result.ok) {
        setSnapshot((current) => (current ? { ...current, ytDlp: result.value } : current));
        setUpdated(kind === "update");
      } else setError(result.error);
    } catch {
      setError("updateFailed");
    } finally {
      pending.current = false;
      setOperation(null);
    }
  };
  return (
    <>
      <SettingsRow label={t("maintenance.ytCurrent")}>
        <span className="font-mono text-xs">{state?.currentVersion ?? t("desktop.unknown")}</span>
      </SettingsRow>
      <SettingsRow label={t("maintenance.ytLatest")}>
        <span className="font-mono text-xs">
          {state?.latestVersion ?? t("maintenance.notChecked")}
        </span>
      </SettingsRow>
      <div className="space-y-3 px-5 py-3">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!api || !state?.supported || busy}
            onClick={() => void run("check")}
          >
            {t("maintenance.checkYtDlp")}
          </Button>
          <Button
            size="sm"
            disabled={!api || !state?.supported || !state.available || busy || state.busy}
            onClick={() => void run("update")}
          >
            {t("maintenance.updateYtDlp")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("maintenance.ytHint")}</p>
        {state && !state.supported && (
          <p className="text-xs text-muted-foreground">{t("desktop.errors.updateUnsupported")}</p>
        )}
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(operation === "update" ? "maintenance.updating" : "desktop.checking")}
          </p>
        )}
        {!busy && state?.busy && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("maintenance.ytBusyHint")}
          </p>
        )}
        {updated && (
          <p role="status" className="text-xs text-success">
            {t("maintenance.ytUpdated")}
          </p>
        )}
        {(error || maintenance.error) && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${error ?? maintenance.error}`)}
          </p>
        )}
      </div>
      <div className="space-y-1 px-5 py-3">
        <p className="text-sm">{t("maintenance.ffmpegSource")}</p>
        <p className="break-words text-xs text-muted-foreground">
          {snapshot?.ffmpegSource ?? t("desktop.unknown")}
        </p>
      </div>
    </>
  );
}

export function AppUpdateSettings({ maintenance }: { maintenance: DesktopMaintenance }) {
  const { t } = useT();
  const { api, snapshot, setSnapshot, loading, refresh } = maintenance;
  const state = snapshot?.app;
  const [operation, setOperation] = useState<"check" | "download" | "install" | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [installing, setInstalling] = useState(false);
  const pending = useRef(false);
  const busy =
    loading ||
    Boolean(operation) ||
    installing ||
    state?.status === "checking" ||
    state?.status === "downloading";
  const run = async (kind: "check" | "download" | "install") => {
    if (!api || !state?.configured || pending.current || busy) return;
    pending.current = true;
    setOperation(kind);
    setError(null);
    try {
      if (kind === "install") {
        const result = await api.maintenance.installApp();
        if (result.ok) setInstalling(true);
        else setError(result.error);
      } else {
        const result = await (kind === "check"
          ? api.maintenance.checkApp()
          : api.maintenance.downloadApp());
        if (result.ok)
          setSnapshot((current) => (current ? { ...current, app: result.value } : current));
        else setError(result.error);
      }
    } catch {
      setError("updateFailed");
    } finally {
      pending.current = false;
      setOperation(null);
    }
  };
  const status =
    operation === "check" ? "checking" : operation === "download" ? "downloading" : state?.status;
  return (
    <SettingsSection icon={RefreshCw} title={t("maintenance.appTitle")}>
      <SettingsRow label={t("maintenance.currentVersion")}>
        <span className="font-mono text-xs">{state?.currentVersion ?? t("desktop.unknown")}</span>
      </SettingsRow>
      <SettingsRow label={t("maintenance.latestVersion")}>
        <span className="font-mono text-xs">
          {state?.latestVersion ?? t("maintenance.notChecked")}
        </span>
      </SettingsRow>
      <div className="space-y-3 px-5 py-3">
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            !api
              ? "desktop.launchTitle"
              : installing
                ? "maintenance.installing"
                : status
                  ? `maintenance.appStatus.${status}`
                  : "common.loading",
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!api || !state?.configured || busy}
            onClick={() => void run("check")}
          >
            {t("maintenance.checkApp")}
          </Button>
          <Button
            size="sm"
            disabled={!api || !state?.configured || state.status !== "available" || busy}
            onClick={() => void run("download")}
          >
            {t("maintenance.downloadApp")}
          </Button>
          <Button
            size="sm"
            disabled={!api || !state?.configured || state.status !== "ready" || busy}
            onClick={() => void run("install")}
          >
            {t("maintenance.installApp")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!api || loading || Boolean(operation) || installing}
            onClick={() => void refresh()}
          >
            {t("maintenance.refresh")}
          </Button>
        </div>
        {(error || maintenance.error) && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${error ?? maintenance.error}`)}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
