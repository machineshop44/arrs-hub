import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  confirmPlexApply,
  fetchPlexUpdateJob,
  fetchPlexUpdateStatus,
  plexCheckResultMessage,
  plexJobBusy,
  postPlexUpdateJob,
  type PlexUpdateStartBody,
  type PlexUpdateStatus,
} from "../lib/plexUpdate";

/**
 * Shared plex update store so Dashboard chip + Settings card share one
 * /api/plex/update-status poll (and one job poll) instead of doubling traffic.
 */
type Store = {
  status: PlexUpdateStatus | null;
  loading: boolean;
  checking: boolean;
  busy: boolean;
  error: string | null;
  actionMsg: string | null;
};

const listeners = new Set<() => void>();
let store: Store = {
  status: null,
  loading: false,
  checking: false,
  busy: false,
  error: null,
  actionMsg: null,
};
let serverUp: boolean | null = null;
let subscriberCount = 0;
let statusTimer: number | null = null;
let jobTimer: number | null = null;
let didStartupRefresh = false;
let inflightStatus: Promise<PlexUpdateStatus> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function setStore(patch: Partial<Store>) {
  store = { ...store, ...patch };
  emit();
}

function clearTimers() {
  if (statusTimer != null) {
    window.clearInterval(statusTimer);
    statusTimer = null;
  }
  if (jobTimer != null) {
    window.clearInterval(jobTimer);
    jobTimer = null;
  }
}

async function loadStatus(
  refresh = false,
  opts: { announce?: boolean } = {},
): Promise<PlexUpdateStatus | null> {
  if (serverUp === false) {
    setStore({
      status: null,
      loading: false,
      checking: false,
      error: null,
    });
    return null;
  }

  if (refresh) {
    setStore({
      checking: true,
      ...(opts.announce ? { error: null, actionMsg: null } : {}),
    });
  } else if (!store.status) {
    setStore({ loading: true });
  }

  try {
    let next: PlexUpdateStatus;
    if (!refresh && inflightStatus) {
      next = await inflightStatus;
    } else {
      const pending = fetchPlexUpdateStatus(refresh);
      if (!refresh) inflightStatus = pending;
      try {
        next = await pending;
      } finally {
        if (!refresh && inflightStatus === pending) inflightStatus = null;
      }
    }

    setStore({
      status: next,
      error: next.error || null,
      loading: false,
      checking: false,
      ...(refresh && opts.announce
        ? { actionMsg: plexCheckResultMessage(next) }
        : {}),
    });
    syncJobPoll();
    return next;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStore({
      error: msg,
      loading: false,
      checking: false,
      ...(refresh && opts.announce ? { actionMsg: null } : {}),
    });
    return null;
  }
}

async function pollJobOnce() {
  try {
    const job = await fetchPlexUpdateJob();
    setStore({
      status: store.status ? { ...store.status, job } : { ok: true, job },
    });
    if (!plexJobBusy(job)) {
      setStore({ busy: false });
      await loadStatus(false);
      if (job.phase === "error") {
        setStore({
          error: job.error || job.message || "Update failed",
        });
      } else if (job.message) {
        setStore({ actionMsg: job.message });
      }
      syncJobPoll();
    }
  } catch (err) {
    setStore({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
    });
    syncJobPoll();
  }
}

function syncJobPoll() {
  const should =
    subscriberCount > 0 &&
    serverUp !== false &&
    (plexJobBusy(store.status?.job) || store.busy);
  if (!should) {
    if (jobTimer != null) {
      window.clearInterval(jobTimer);
      jobTimer = null;
    }
    return;
  }
  if (jobTimer != null) return;
  jobTimer = window.setInterval(() => void pollJobOnce(), 1200);
}

function startStatusPoll() {
  if (statusTimer != null || serverUp === false) return;
  statusTimer = window.setInterval(() => void loadStatus(false), 60000);
}

function stopIfIdle() {
  if (subscriberCount > 0) return;
  clearTimers();
  inflightStatus = null;
}

async function startJob(
  body: PlexUpdateStartBody,
  confirmApply: boolean,
): Promise<void> {
  if (confirmApply && !confirmPlexApply(Boolean(body.tonight))) return;

  setStore({ busy: true, error: null, actionMsg: null });
  try {
    const job = await postPlexUpdateJob(body);
    const prev = store.status;
    setStore({
      status: prev
        ? { ...prev, job }
        : {
            ok: true,
            installedVersion: null,
            latestVersion: null,
            updateAvailable: false,
            canInstall: false,
            channel: null,
            releaseState: null,
            lastChecked: null,
            error: null,
            job,
          },
    });
    if (!plexJobBusy(job)) {
      setStore({
        busy: false,
        actionMsg: job.message || "Done.",
      });
      await loadStatus(false);
    } else {
      syncJobPoll();
    }
  } catch (err) {
    setStore({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Store {
  return store;
}

export function usePlexUpdate(nextServerUp: boolean | null) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    subscriberCount += 1;
    const prevUp = serverUp;
    serverUp = nextServerUp;

    if (nextServerUp === false) {
      clearTimers();
      inflightStatus = null;
      setStore({
        status: null,
        loading: false,
        checking: false,
        busy: false,
        error: null,
        actionMsg: null,
      });
      syncJobPoll();
    } else {
      // Coming back online: allow a fresh PMS check and drop stale status.
      if (prevUp === false) {
        didStartupRefresh = false;
        setStore({ status: null, loading: true, error: null, actionMsg: null });
      }
      void loadStatus(false);
      startStatusPoll();
      if (!didStartupRefresh) {
        didStartupRefresh = true;
        void loadStatus(true);
      }
      syncJobPoll();
    }

    return () => {
      subscriberCount = Math.max(0, subscriberCount - 1);
      stopIfIdle();
    };
  }, [nextServerUp]);

  const load = useCallback(
    (refresh = false, opts: { announce?: boolean } = {}) =>
      loadStatus(refresh, opts),
    [],
  );

  const runJob = useCallback(
    (body: PlexUpdateStartBody, confirmApply: boolean) =>
      startJob(body, confirmApply),
    [],
  );

  return {
    status: snap.status,
    loading: snap.loading,
    checking: snap.checking,
    busy: snap.busy,
    error: snap.error,
    actionMsg: snap.actionMsg,
    load,
    startJob: runJob,
    jobBusy: plexJobBusy(snap.status?.job),
  };
}
