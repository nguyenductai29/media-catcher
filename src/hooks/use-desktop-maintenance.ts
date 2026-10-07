import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useDesktopAPI } from "@/hooks/use-desktop";
import type { ErrorCode, MaintenanceSnapshot } from "../../shared/models";

export function useDesktopMaintenance() {
  const api = useDesktopAPI();
  const [snapshot, replaceSnapshot] = useState<MaintenanceSnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [error, setError] = useState<ErrorCode | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const setSnapshot = useCallback((value: SetStateAction<MaintenanceSnapshot | null>) => {
    // An action result is newer than any cached read already in flight.
    generation.current++;
    setLoading(false);
    replaceSnapshot(value);
  }, []);
  const refresh = useCallback(async () => {
    if (!api) return;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.maintenance.get();
      if (request !== generation.current) return;
      if (result.ok) replaceSnapshot(result.value);
      else setError(result.error);
    } catch {
      if (request === generation.current) setError("updateFailed");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  return { api, snapshot, setSnapshot, loading, error, refresh };
}
export type DesktopMaintenance = ReturnType<typeof useDesktopMaintenance>;
