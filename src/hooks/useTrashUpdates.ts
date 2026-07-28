import { useCallback, useEffect, useState } from "react";
import {
  fetchTrashUpdates,
  type TrashUpdatesSnapshot,
} from "../trashUpdates";

const STORAGE_KEY = "arrs-hub-trash-seen-sha";

export function useTrashUpdates(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<TrashUpdatesSnapshot | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchTrashUpdates();
      setSnapshot(next);

      const seen = localStorage.getItem(STORAGE_KEY);
      if (!seen) {
        // First visit: remember current version, don't alarm
        localStorage.setItem(STORAGE_KEY, next.commit.sha);
        setHasUpdate(false);
      } else {
        setHasUpdate(seen !== next.commit.sha);
      }
      setDismissed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check updates");
      setHasUpdate(false);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markSeen = useCallback(() => {
    if (!snapshot) return;
    localStorage.setItem(STORAGE_KEY, snapshot.commit.sha);
    setHasUpdate(false);
    setDismissed(true);
  }, [snapshot]);

  const showBanner = enabled && hasUpdate && !dismissed && Boolean(snapshot);

  return {
    snapshot,
    hasUpdate,
    showBanner,
    loading,
    error,
    refresh,
    markSeen,
  };
}
