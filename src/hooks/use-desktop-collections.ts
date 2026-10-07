import { useEffect, useRef, useState } from "react";
import { useDesktopAPI } from "./use-desktop";
import type { ActivityItem, DownloadJob, ErrorCode, MediaItem, Result } from "../../shared/models";

type Collection<T> = {
  list(): Promise<Result<T[]>>;
  onChanged(listener: (items: T[]) => void): () => void;
};

function useCollection<T>(source: Collection<T> | undefined) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorCode | null>(null);
  useEffect(() => {
    if (!source) {
      setLoading(false);
      return;
    }
    let active = true;
    let receivedEvent = false;
    setLoading(true);
    const unsubscribe = source.onChanged((next) => {
      if (!active) return;
      receivedEvent = true;
      setItems(next);
      setLoading(false);
      setError(null);
    });
    void source
      .list()
      .then((result) => {
        if (!active || receivedEvent) return;
        if (result.ok) setItems(result.value);
        else setError(result.error);
        setLoading(false);
      })
      .catch(() => {
        if (active && !receivedEvent) {
          setError("unavailable");
          setLoading(false);
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [source]);
  return { items, loading, error };
}

export function useDesktopDownloads() {
  const api = useDesktopAPI();
  return { api, ...useCollection<DownloadJob>(api?.downloads) };
}
export function useDesktopLibrary() {
  const api = useDesktopAPI();
  return { api, ...useCollection<MediaItem>(api?.library) };
}
export function useDesktopActivity() {
  const api = useDesktopAPI();
  return { api, ...useCollection<ActivityItem>(api?.activity) };
}

export function useDesktopAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const pending = useRef(false);
  const run = async <T>(action: () => Promise<Result<T>>): Promise<Result<T> | undefined> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.error);
      return result;
    } catch {
      setError("unavailable");
      return { ok: false, error: "unavailable" };
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}
