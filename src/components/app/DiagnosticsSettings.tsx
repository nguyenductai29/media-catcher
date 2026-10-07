import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/app/SettingsSection";
import { useDesktopAPI } from "@/hooks/use-desktop";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/media-display";
import type {
  DiagnosticLogEntry,
  DiagnosticsSnapshot,
  ErrorCode,
  LogComponent,
  LogFilter,
} from "../../../shared/models";

const components: LogComponent[] = [
  "download",
  "upload",
  "drive",
  "ipc",
  "startup",
  "shutdown",
  "browser",
  "update",
  "diagnostics",
];
const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50";

export function DiagnosticsSettings() {
  const { t, lang } = useT();
  const api = useDesktopAPI();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([]);
  const [component, setComponent] = useState<LogComponent | "">("");
  const [kind, setKind] = useState<"error" | "event" | "">("");
  const [selected, setSelected] = useState("");
  const [loadingSnapshot, setLoadingSnapshot] = useState(Boolean(api));
  const [loadingLogs, setLoadingLogs] = useState(Boolean(api));
  const [busy, setBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<ErrorCode | null>(null);
  const [logError, setLogError] = useState<ErrorCode | null>(null);
  const [actionError, setActionError] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const snapshotGeneration = useRef(0);
  const logGeneration = useRef(0);
  const invalidateSnapshot = useCallback(() => {
    snapshotGeneration.current++;
  }, []);
  const invalidateLogs = useCallback(() => {
    logGeneration.current++;
  }, []);
  const filter = useMemo<LogFilter>(
    () => ({ ...(component ? { component } : {}), ...(kind ? { kind } : {}) }),
    [component, kind],
  );
  const readSnapshot = useCallback(async () => {
    if (!api) return;
    const request = ++snapshotGeneration.current;
    setLoadingSnapshot(true);
    setSnapshotError(null);
    try {
      const result = await api.diagnostics.get();
      if (request !== snapshotGeneration.current) return;
      if (result.ok) setSnapshot(result.value);
      else setSnapshotError(result.error);
    } catch {
      if (request === snapshotGeneration.current) setSnapshotError("diagnosticsFailed");
    } finally {
      if (request === snapshotGeneration.current) setLoadingSnapshot(false);
    }
  }, [api]);
  const readLogs = useCallback(async () => {
    if (!api) return;
    const request = ++logGeneration.current;
    setLoadingLogs(true);
    setLogError(null);
    setSelected("");
    setEntries([]);
    try {
      const result = await api.diagnostics.logs(filter);
      if (request !== logGeneration.current) return;
      if (result.ok) setEntries(result.value.slice(0, 200));
      else setLogError(result.error);
    } catch {
      if (request === logGeneration.current) setLogError("diagnosticsFailed");
    } finally {
      if (request === logGeneration.current) setLoadingLogs(false);
    }
  }, [api, filter]);
  useEffect(() => {
    void readSnapshot();
    return invalidateSnapshot;
  }, [readSnapshot, invalidateSnapshot]);
  useEffect(() => {
    setNotice(null);
    void readLogs();
    return invalidateLogs;
  }, [readLogs, invalidateLogs]);
  const run = async (action: "refresh" | "copy" | "open" | "clear" | "export") => {
    if (!api || pending.current) return;
    if (action === "copy" && !entries.some((entry) => entry.id === selected)) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      if (action === "refresh") {
        await Promise.all([readSnapshot(), readLogs()]);
        return;
      }
      const result = await (action === "copy"
        ? api.diagnostics.copyLog(selected)
        : action === "open"
          ? api.diagnostics.openLogs()
          : action === "clear"
            ? api.diagnostics.clearLogs()
            : api.diagnostics.exportDiagnostics());
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
      if (action === "clear") {
        await readLogs();
        setNotice("diagnostics.cleared");
      } else if (action === "copy") setNotice("diagnostics.copied");
      else if (action === "export" && result.value === true) setNotice("diagnostics.exported");
    } catch {
      setActionError("diagnosticsFailed");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const unknown = t("desktop.unknown");
  const yesNo = (value: boolean) => t(value ? "diagnostics.yes" : "diagnostics.no");
  const settings = snapshot?.settings;
  const fields: [string, string | number][] =
    snapshot && settings
      ? [
          [t("diagnostics.fields.appVersion"), snapshot.appVersion],
          [t("diagnostics.fields.electronVersion"), snapshot.electronVersion],
          [t("diagnostics.fields.nodeVersion"), snapshot.nodeVersion],
          [t("diagnostics.fields.platform"), snapshot.platform],
          [t("diagnostics.fields.architecture"), snapshot.architecture],
          [t("diagnostics.fields.schemaVersion"), snapshot.schemaVersion],
          [t("diagnostics.fields.databasePath"), snapshot.databasePath],
          [t("diagnostics.fields.downloadFolder"), snapshot.downloadFolder],
          ...(["ytDlp", "ffmpeg", "ffprobe"] as const).map(
            (key) =>
              [
                t(`settings.binary.${key}`),
                `${t(`settings.binary.${snapshot.binaries[key].state}`)} · ${snapshot.binaries[key].version ?? unknown}`,
              ] as [string, string],
          ),
          [t("diagnostics.fields.driveConnected"), yesNo(snapshot.driveConnected)],
          [
            t("diagnostics.fields.browserSession"),
            t(`diagnostics.session.${snapshot.browserSession}`),
          ],
          [t("diagnostics.fields.activeDownloads"), snapshot.activeDownloads],
          [t("diagnostics.fields.activeUploads"), snapshot.activeUploads],
          [
            t("diagnostics.fields.availableDiskSpace"),
            formatBytes(snapshot.availableDiskSpace ?? undefined, lang, unknown),
          ],
          [t("settings.language"), t(`onboarding.languages.${settings.language}`)],
          [t("product.appearance"), t(`product.theme.${settings.theme}`)],
          [t("product.closeBehavior"), t(`product.close.${settings.closeBehavior}`)],
          [t("settings.startWin"), yesNo(settings.startWithWindows)],
          [t("settings.quality"), t(`downloadDialog.quality.${settings.quality}`)],
          [t("settings.format"), t(`downloadDialog.container.${settings.container}`)],
          [t("diagnostics.fields.downloadConcurrency"), settings.downloadConcurrency],
          [t("diagnostics.fields.uploadConcurrency"), settings.uploadConcurrency],
          [t("settings.autoUpload"), yesNo(settings.autoUpload)],
          [
            t("settings.deleteAfter"),
            t(`settings.${settings.deleteLocal === "automatic" ? "auto" : settings.deleteLocal}`),
          ],
        ]
      : [];
  const disabled = !api || busy;
  const error = actionError || snapshotError || logError;
  return (
    <SettingsSection icon={FileText} title={t("diagnostics.title")}>
      <div className="space-y-3 px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {t(api ? "diagnostics.hint" : "desktop.launchTitle")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || loadingSnapshot || loadingLogs}
            onClick={() => void run("refresh")}
          >
            {t("diagnostics.refresh")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void run("export")}
          >
            {t("diagnostics.exportTitle")}
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run("open")}>
            {t("diagnostics.openLogs")}
          </Button>
        </div>
        {loadingSnapshot && <p className="text-xs text-muted-foreground">{t("common.loading")}</p>}
        <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          {fields.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-3 px-5 py-3">
        <h3 className="text-sm font-semibold">{t("diagnostics.logs")}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">{t("diagnostics.component")}</span>
            <select
              className={selectClass}
              aria-label={t("diagnostics.component")}
              value={component}
              disabled={disabled}
              onChange={(event) => setComponent(event.target.value as LogComponent | "")}
            >
              <option value="">{t("diagnostics.allComponents")}</option>
              {components.map((value) => (
                <option key={value} value={value}>
                  {t(`diagnostics.components.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">{t("diagnostics.kind")}</span>
            <select
              className={selectClass}
              aria-label={t("diagnostics.kind")}
              value={kind}
              disabled={disabled}
              onChange={(event) => setKind(event.target.value as "error" | "event" | "")}
            >
              <option value="">{t("diagnostics.allKinds")}</option>
              <option value="error">{t("diagnostics.kinds.error")}</option>
              <option value="event">{t("diagnostics.kinds.event")}</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || loadingLogs || !selected}
            onClick={() => void run("copy")}
          >
            {t("diagnostics.copy")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || loadingLogs}
            onClick={() => void run("clear")}
          >
            {t("diagnostics.clear")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("diagnostics.limit", { count: 200 })}</p>
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 text-muted-foreground">
              <tr>
                <th className="p-2">{t("diagnostics.select")}</th>
                <th className="p-2">{t("diagnostics.time")}</th>
                <th className="p-2">{t("diagnostics.component")}</th>
                <th className="p-2">{t("diagnostics.message")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const time = new Date(entry.time).toLocaleString(lang);
                return (
                  <tr key={entry.id} className="border-t border-border">
                    <td className="p-2">
                      <input
                        type="radio"
                        name="diagnostic-log"
                        aria-label={t("diagnostics.selectEntry", { time })}
                        checked={selected === entry.id}
                        disabled={disabled || loadingLogs}
                        onChange={() => {
                          setSelected(entry.id);
                          setNotice(null);
                        }}
                      />
                    </td>
                    <td className="whitespace-nowrap p-2 font-mono">{time}</td>
                    <td className="p-2">{t(`diagnostics.components.${entry.component}`)}</td>
                    <td className="min-w-48 p-2">
                      <span className="mr-2 text-muted-foreground">
                        {t(entry.code ? "diagnostics.kinds.error" : "diagnostics.kinds.event")}
                      </span>
                      {entry.code
                        ? t(`desktop.errors.${entry.code}`)
                        : entry.event
                          ? t(`diagnostics.events.${entry.event}`)
                          : unknown}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!entries.length && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {t(loadingLogs ? "common.loading" : "diagnostics.empty")}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t(`desktop.errors.${error}`)}
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-success">
            {t(notice)}
          </p>
        )}
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("diagnostics.working")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
