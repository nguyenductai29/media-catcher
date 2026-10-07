import { useEffect, useRef, useState } from "react";
import type { MediaVaultAPI } from "../../shared/ipc-types";
import type { DriveSnapshot, ErrorCode } from "../../shared/models";
import { useDesktopAPI } from "./use-desktop";

const initialState: DriveSnapshot = {
  account: { connected: false, configured: false, connecting: false },
  uploads: [],
  settings: { concurrency: 2, autoUpload: false, deleteLocal: "never", chunkSizeMiB: 8 },
  syncing: false,
};
export function useDesktopDrive() {
  const api = useDesktopAPI();
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let receivedEvent = false;
    setLoading(true);
    const unsubscribe = api.drive.onChanged((next) => {
      if (!active) return;
      receivedEvent = true;
      setState(next);
      setLoading(false);
      setError(null);
    });
    void api.drive
      .getState()
      .then((result) => {
        if (!active || receivedEvent) return;
        if (result.ok) setState(result.value);
        else setError(result.error);
        setLoading(false);
      })
      .catch(() => {
        if (active && !receivedEvent) {
          setError("driveUnavailable");
          setLoading(false);
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);
  return { api, state, loading: !!api && loading, error };
}

type AccountCommand = "connect" | "disconnect" | "sync";
export function useDriveAccountActions(api: MediaVaultAPI | null) {
  const [command, setCommand] = useState<AccountCommand | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const current = useRef<{ command: AccountCommand; generation: number } | null>(null);
  const generation = useRef(0);
  const run = async (next: AccountCommand) => {
    if (!api || (current.current && !(next === "disconnect" && current.current.command === "sync")))
      return;
    const operation = ++generation.current;
    current.current = { command: next, generation: operation };
    setCommand(next);
    setError(null);
    try {
      const result = await api.drive[next]();
      if (current.current?.generation === operation && !result.ok) setError(result.error);
    } catch {
      if (current.current?.generation === operation) setError("driveUnavailable");
    } finally {
      // Main aborts Sync on Disconnect. Its late result must not reset the newer action.
      if (current.current?.generation === operation) {
        current.current = null;
        setCommand(null);
      }
    }
  };
  return { command, busy: command !== null, error, run };
}
