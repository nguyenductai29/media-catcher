import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Cloud, CloudOff, Pause, Play, RotateCcw, Upload, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Bar,
  EmptyState,
  IconBtn,
  PageHeader,
  Segmented,
  StatusBadge,
} from "@/components/app/primitives";
import { DriveAccountControls, MediaAvailabilityBadges } from "@/components/app/DriveControls";
import { MediaThumbnail } from "@/components/app/MediaThumbnail";
import { useDesktopDrive, useDriveAccountActions } from "@/hooks/use-desktop-drive";
import { useDesktopAction, useDesktopLibrary } from "@/hooks/use-desktop-collections";
import {
  activeUploadStatuses,
  canOpenDrive,
  canRetryUpload,
  hasDriveFile,
  latestUpload,
  canUploadMedia,
  hasLocalFile,
} from "@/lib/drive-display";
import { formatBytes, formatDuration } from "@/lib/media-display";
import { useT } from "@/lib/i18n";
import type { DriveUpload, MediaItem } from "../../shared/models";

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

type Tab = "uploaded" | "uploading" | "local" | "failed";
function DrivePage() {
  const { t, lang } = useT();
  const { api, state, loading, error } = useDesktopDrive();
  const library = useDesktopLibrary();
  const action = useDesktopAction();
  const accountActions = useDriveAccountActions(api);
  const busy = action.busy || accountActions.busy;
  const [tab, setTab] = useState<Tab>("uploading");
  const { account, uploads } = state;
  const bytes = (value: number | undefined) => formatBytes(value, lang, t("drive.unavailable"));
  const jobAction = (id: string, command: "pause" | "resume" | "cancel" | "retry") => {
    if (api) void action.run(() => api.drive[command](id));
  };
  const mediaAction = (item: MediaItem, command: "upload" | "open") => {
    if (api) void action.run<unknown>(() => api.drive[command](item.id));
  };
  const uploadItems = uploads.filter((job) => activeUploadStatuses.has(job.status));
  const failedItems = uploads.filter((job) => job.status === "failed");
  const uploadedItems = library.items.filter((item) => !!item.driveFileId);
  const localItems = library.items.filter((item) => !item.driveAvailable);
  const count = {
    uploaded: uploadedItems.length,
    uploading: uploadItems.length,
    local: localItems.length,
    failed: failedItems.length,
  };
  const errorCode =
    accountActions.error ?? action.error ?? error ?? state.error ?? account.error ?? library.error;
  const quotaValid =
    account.storageLimit !== undefined &&
    account.storageLimit > 0 &&
    account.storageUsed !== undefined;
  const renderMedia = (item: MediaItem) => (
    <div key={item.id} className="panel flex items-center gap-4 p-3">
      <MediaThumbnail item={item} className="w-24 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{item.title}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{bytes(item.fileSize)}</p>
        <div className="mt-2">
          <MediaAvailabilityBadges item={item} account={account} />
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {item.driveFileId ? (
          <IconBtn
            icon={ExternalLink}
            label={t("common.openInDrive")}
            disabled={busy || !canOpenDrive(item, account)}
            onClick={() => mediaAction(item, "open")}
          />
        ) : null}
        {!hasDriveFile(item) && (
          <Button
            variant="subtle"
            size="sm"
            disabled={busy || !account.connected || !canUploadMedia(item, account, uploads)}
            onClick={() => mediaAction(item, "upload")}
          >
            <Upload />
            {t("common.uploadDrive")}
          </Button>
        )}
        {latestUpload(item, uploads, account)?.status === "failed" && (
          <IconBtn
            icon={RotateCcw}
            label={t("drive.retryUpload")}
            disabled={busy || !canRetryUpload(item, latestUpload(item, uploads, account)!, account)}
            onClick={() => jobAction(latestUpload(item, uploads, account)!.id, "retry")}
          />
        )}
      </div>
    </div>
  );
  const renderUpload = (job: DriveUpload) => {
    const item = library.items.find((item) => item.id === job.mediaId);
    const sameAccount = account.connected && job.providerAccountId === account.providerAccountId;
    const pct = Math.min(
      job.status === "completed" ? 100 : 99,
      Math.round(Math.max(0, job.progress)),
    );
    return (
      <div key={job.id} className="panel flex items-center gap-4 p-3">
        <MediaThumbnail item={item} className="w-24 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold">{item?.title ?? job.fileName}</p>
            <StatusBadge status={job.status} />
            {account.providerAccountId && job.providerAccountId !== account.providerAccountId && (
              <StatusBadge status="paused" label={t("drive.otherAccount")} />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="font-mono">
              {job.fileName} · {bytes(job.fileSize)}
            </span>
            {item && <span>{t(hasLocalFile(item) ? "drive.local" : "drive.localMissing")}</span>}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Bar value={pct} status={job.status} className="flex-1" />
            <span className="w-10 text-right font-mono text-xs">{pct}%</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-[11px] text-muted-foreground">
            <span>
              {bytes(job.uploadedBytes)} / {bytes(job.fileSize)}
            </span>
            {job.status === "uploading" && (
              <>
                <span>
                  {job.speed === undefined
                    ? t("drive.unavailable")
                    : t("downloads.speedValue", { value: bytes(job.speed) })}
                </span>
                <span>
                  {t("downloads.eta")} {formatDuration(job.eta)}
                </span>
              </>
            )}
            {job.error && (
              <span className="font-sans text-destructive">{t(`desktop.errors.${job.error}`)}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {["queued", "preparing", "uploading", "finalizing"].includes(job.status) && (
            <IconBtn
              icon={Pause}
              label={t("common.pause")}
              disabled={busy || !sameAccount}
              onClick={() => jobAction(job.id, "pause")}
            />
          )}
          {job.status === "paused" && (
            <IconBtn
              icon={Play}
              label={t("common.resume")}
              disabled={busy || !sameAccount}
              onClick={() => jobAction(job.id, "resume")}
            />
          )}
          {job.status === "failed" && (
            <IconBtn
              icon={RotateCcw}
              label={t("drive.retryUpload")}
              disabled={busy || !item || !canRetryUpload(item, job, account)}
              onClick={() => jobAction(job.id, "retry")}
            />
          )}
          {activeUploadStatuses.has(job.status) && (
            <IconBtn
              icon={X}
              label={t("common.cancel")}
              disabled={busy}
              onClick={() => jobAction(job.id, "cancel")}
            />
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader title={t("nav.drive")} />
      <div className="panel mt-5 flex flex-wrap items-center gap-6 p-5">
        <div className="grid size-12 place-items-center rounded-xl bg-primary/10">
          <Cloud className="size-6 text-primary" />
        </div>
        <dl className="grid min-w-0 flex-1 grid-cols-3 gap-6 text-sm">
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("drive.account")}</dt>
            <dd className="mt-0.5 truncate font-medium">
              {account.connected
                ? (account.email ?? account.displayName ?? t("drive.unavailable"))
                : t("drive.notConnected")}
            </dd>
            {account.connected && account.displayName && (
              <dd className="mt-1 truncate text-xs text-muted-foreground">{account.displayName}</dd>
            )}
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("drive.status")}</dt>
            <dd className="mt-1">
              <StatusBadge
                status={account.connected ? "uploaded" : "queued"}
                label={t(
                  account.connecting
                    ? "drive.connecting"
                    : account.connected
                      ? "status.connected"
                      : "drive.notConnected",
                )}
              />
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">{t("drive.storage")}</dt>
            <dd className="mt-0.5 space-y-1 font-mono text-xs">
              <p>
                {t("drive.quotaUsed")}: {bytes(account.storageUsed)}
              </p>
              <p>
                {t("drive.quotaTotal")}: {bytes(account.storageLimit)}
              </p>
              <p>
                {t("drive.quotaAvailable")}:{" "}
                {bytes(
                  quotaValid
                    ? Math.max(0, account.storageLimit! - account.storageUsed!)
                    : undefined,
                )}
              </p>
            </dd>
            {quotaValid && (
              <Bar
                value={Math.min(100, (account.storageUsed! / account.storageLimit!) * 100)}
                className="mt-2"
              />
            )}
          </div>
        </dl>
        <DriveAccountControls
          state={state}
          available={!!api}
          busy={busy}
          disconnecting={accountActions.command === "disconnect"}
          onAction={(command) => void accountActions.run(command)}
        />
        <div className="w-full border-t border-border pt-3 text-xs text-muted-foreground">
          {t("drive.rootFolder")}:{" "}
          <span className="text-foreground">
            {account.rootFolderName ?? t("drive.unavailable")}
          </span>
        </div>
      </div>
      {errorCode && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {t(`desktop.errors.${errorCode}`)}
        </p>
      )}
      {loading ? (
        <p role="status" className="mt-5 text-sm text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : (
        <>
          {!account.connected && (
            <div className="panel mt-5">
              <EmptyState
                icon={CloudOff}
                title={t("drive.notConnected")}
                hint={t(
                  !api
                    ? "desktop.launchHint"
                    : !account.configured
                      ? "desktop.errors.driveNotConfigured"
                      : account.connecting
                        ? "drive.browserHint"
                        : "drive.connectHint",
                )}
              />
            </div>
          )}
          {(account.connected || uploads.length > 0 || uploadedItems.length > 0) && (
            <>
              <Segmented
                className="mt-5"
                value={tab}
                onChange={setTab}
                items={(["uploaded", "uploading", "local", "failed"] as Tab[]).map((value) => ({
                  value,
                  label: t(`drive.tabs.${value}`),
                  count: count[value],
                }))}
              />
              <div className="mt-3 space-y-2">
                {count[tab] === 0 ? (
                  <div className="panel">
                    <EmptyState icon={Cloud} title={t("drive.empty")} />
                  </div>
                ) : tab === "uploaded" ? (
                  uploadedItems.map(renderMedia)
                ) : tab === "local" ? (
                  localItems.map(renderMedia)
                ) : (
                  (tab === "failed" ? failedItems : uploadItems).map(renderUpload)
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
