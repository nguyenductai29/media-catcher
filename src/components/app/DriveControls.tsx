import { Link2, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./primitives";
import { useT } from "@/lib/i18n";
import { mediaStorage, otherDriveAccount } from "@/lib/drive-display";
import type { DriveAccount, DriveSnapshot, DriveUpload, MediaItem } from "../../../shared/models";

export function DriveAccountControls({
  state,
  available,
  busy,
  disconnecting,
  onAction,
}: {
  state: DriveSnapshot;
  available: boolean;
  busy: boolean;
  disconnecting: boolean;
  onAction: (action: "connect" | "disconnect" | "sync") => void;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {state.account.connected ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={!available || disconnecting}
            onClick={() => onAction("disconnect")}
          >
            <Unplug />
            {t("drive.disconnect")}
          </Button>
          <Button
            size="sm"
            variant="glow"
            disabled={busy || state.syncing}
            onClick={() => onAction("sync")}
          >
            <RefreshCw className={state.syncing ? "animate-spin" : ""} />
            {t(state.syncing ? "drive.syncing" : "drive.sync")}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="glow"
          disabled={!available || !state.account.configured || busy || state.account.connecting}
          onClick={() => onAction("connect")}
        >
          <Link2 className={state.account.connecting ? "animate-pulse" : ""} />
          {t(state.account.connecting ? "drive.connecting" : "drive.connect")}
        </Button>
      )}
    </div>
  );
}
export function MediaAvailabilityBadges({
  item,
  account,
  upload,
}: {
  item: MediaItem;
  account: DriveAccount;
  upload?: DriveUpload | undefined;
}) {
  const { t } = useT();
  const storage = mediaStorage(item);
  return (
    <div className="flex flex-wrap gap-1.5">
      <StatusBadge
        status={
          storage === "missing" ? "failed" : storage === "localOnly" ? "localOnly" : "uploaded"
        }
        label={t(`drive.storageState.${storage}`)}
      />
      {otherDriveAccount(item, account) ? (
        <StatusBadge status="paused" label={t("drive.otherAccount")} />
      ) : item.driveStatus === "changed" ? (
        <StatusBadge status="paused" label={t("drive.localChanged")} />
      ) : item.driveStatus === "missing" ? (
        <StatusBadge status="failed" label={t("drive.cloudMissing")} />
      ) : upload && upload.status !== "completed" && upload.status !== "cancelled" ? (
        <StatusBadge status={upload.status} />
      ) : null}
    </div>
  );
}
