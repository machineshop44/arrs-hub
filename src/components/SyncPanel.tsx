import { useCallback, useEffect, useMemo, useState } from "react";
import { useModalBackdropClose } from "../hooks/useModalBackdropClose";
import type { ConnectionMode, ServiceConfig } from "../types";
import { getServiceUrl } from "../types";
import { SyncProgressOverlay } from "./SyncProgressOverlay";

interface SyncPanelProps {
  onClose: () => void;
  connectionMode: ConnectionMode;
  services: ServiceConfig[];
}

type ProgressState = {
  title: string;
  status: string;
  log: string;
  done: boolean;
  error: string | null;
  mode: "preview" | "apply" | "install";
};

async function readSyncStream(
  res: Response,
  onStatus: (message: string) => void,
  onLog: (chunk: string) => void,
): Promise<{
  ok: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
}> {
  if (!res.body) throw new Error("No response body from sync server");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: {
    ok: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
  } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === "status" && typeof payload.message === "string") {
        onStatus(payload.message);
      }
      if (event === "log" && typeof payload.chunk === "string") {
        onLog(payload.chunk);
      }
      if (event === "done") {
        result = payload as {
          ok: boolean;
          error?: string;
          stdout?: string;
          stderr?: string;
        };
      }
    }
  }

  if (!result) throw new Error("Sync ended without a result");
  return result;
}

type ArrForm = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
};

type SyncForm = {
  sonarr: ArrForm;
  radarr: ArrForm;
  selectedPresets: string[];
};

type Preset = {
  id: string;
  label: string;
  description: string;
};

function hubUrlFor(
  services: ServiceConfig[],
  id: string,
  mode: ConnectionMode,
): string | null {
  const service = services.find((item) => item.id === id);
  if (!service || !service.enabled) return null;
  return getServiceUrl(service, mode);
}

export function SyncPanel({ onClose, connectionMode, services }: SyncPanelProps) {
  const sonarrHubUrl = useMemo(
    () => hubUrlFor(services, "sonarr", connectionMode),
    [services, connectionMode],
  );
  const radarrHubUrl = useMemo(
    () => hubUrlFor(services, "radarr", connectionMode),
    [services, connectionMode],
  );

  const [form, setForm] = useState<SyncForm>({
    sonarr: { enabled: true, baseUrl: "", apiKey: "" },
    radarr: { enabled: true, baseUrl: "", apiKey: "" },
    selectedPresets: ["sonarr-web-1080p", "radarr-hd-bluray-web"],
  });
  const [presets, setPresets] = useState<Preset[]>([]);
  const [status, setStatus] = useState<{
    recyclarrInstalled?: boolean;
    recyclarrVersion?: string | null;
  } | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const [log, setLog] = useState("");
  const [sonarrKeySet, setSonarrKeySet] = useState(false);
  const [radarrKeySet, setRadarrKeySet] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const backdrop = useModalBackdropClose(() => {
    if (progress) return;
    onClose();
  });
  const [includeQualityProfiles, setIncludeQualityProfiles] = useState(true);
  const [includeQualityDefinition, setIncludeQualityDefinition] =
    useState(true);

  const modeLabel = connectionMode === "home" ? "Home" : "Remote";

  const load = useCallback(async () => {
    try {
      const health = await fetch("/api/health");
      setServerUp(health.ok);
      if (!health.ok) return;

      const [presetsRes, settingsRes, statusRes] = await Promise.all([
        fetch("/api/sync/presets"),
        fetch("/api/sync/settings"),
        fetch("/api/sync/status"),
      ]);

      const presetsJson = await presetsRes.json();
      const settingsJson = await settingsRes.json();
      const statusJson = await statusRes.json();

      setPresets(presetsJson.presets ?? []);
      setStatus(statusJson);
      setSonarrKeySet(Boolean(settingsJson.settings?.sonarr?.apiKeySet));
      setRadarrKeySet(Boolean(settingsJson.settings?.radarr?.apiKeySet));

      setForm({
        sonarr: {
          enabled: settingsJson.settings?.sonarr?.enabled ?? true,
          baseUrl:
            sonarrHubUrl ||
            settingsJson.settings?.sonarr?.baseUrl ||
            "http://localhost:8989",
          apiKey: "",
        },
        radarr: {
          enabled: settingsJson.settings?.radarr?.enabled ?? true,
          baseUrl:
            radarrHubUrl ||
            settingsJson.settings?.radarr?.baseUrl ||
            "http://localhost:7878",
          apiKey: "",
        },
        selectedPresets: settingsJson.settings?.selectedPresets ?? [],
      });
    } catch {
      setServerUp(false);
    }
  }, [sonarrHubUrl, radarrHubUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep URLs in sync if Auto/Home/Remote changes while panel is open
  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      sonarr: {
        ...prev.sonarr,
        baseUrl: sonarrHubUrl || prev.sonarr.baseUrl,
      },
      radarr: {
        ...prev.radarr,
        baseUrl: radarrHubUrl || prev.radarr.baseUrl,
      },
    }));
  }, [sonarrHubUrl, radarrHubUrl]);

  const saveSettings = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const payload = {
        ...form,
        sonarr: {
          ...form.sonarr,
          baseUrl: sonarrHubUrl || form.sonarr.baseUrl,
        },
        radarr: {
          ...form.radarr,
          baseUrl: radarrHubUrl || form.radarr.baseUrl,
        },
      };
      const res = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setMessage({ type: "ok", text: "Sync settings saved." });
      await load();
    } catch (err) {
      setMessage({
        type: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const installRecyclarr = async () => {
    setBusy(true);
    setMessage(null);
    setProgress({
      title: "Downloading Recyclarr",
      status: "Fetching latest Windows build from GitHub…",
      log: "",
      done: false,
      error: null,
      mode: "install",
    });
    try {
      const res = await fetch("/api/sync/install", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Install failed");
      const text = json.downloaded
        ? `Recyclarr installed (${json.version || "ok"}).`
        : `Recyclarr already present (${json.version || "ok"}).`;
      setProgress({
        title: "Downloading Recyclarr",
        status: text,
        log: text,
        done: true,
        error: null,
        mode: "install",
      });
      setMessage({ type: "ok", text });
      await load();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setProgress({
        title: "Downloading Recyclarr",
        status: "Failed",
        log: "",
        done: true,
        error: text,
        mode: "install",
      });
      setMessage({ type: "err", text });
    } finally {
      setBusy(false);
    }
  };

  const runSyncJob = async (
    preview: boolean,
    applyOptions?: {
      includeQualityProfiles?: boolean;
      includeQualityDefinition?: boolean;
    },
  ) => {
    if (form.sonarr.enabled && !sonarrHubUrl) {
      setMessage({
        type: "err",
        text: `Sonarr has no ${modeLabel} URL in hub Settings. Add one, or switch Auto/Home/Remote.`,
      });
      return;
    }
    if (form.radarr.enabled && !radarrHubUrl) {
      setMessage({
        type: "err",
        text: `Radarr has no ${modeLabel} URL in hub Settings. Add one, or switch Auto/Home/Remote.`,
      });
      return;
    }

    const profiles =
      applyOptions?.includeQualityProfiles ?? includeQualityProfiles;
    const sizes =
      applyOptions?.includeQualityDefinition ?? includeQualityDefinition;
    if (!preview && !profiles && !sizes) {
      setMessage({
        type: "err",
        text: "Select at least one change type to apply (profiles/custom formats or quality sizes).",
      });
      return;
    }

    setBusy(true);
    setMessage(null);
    setLog("");
    setProgress({
      title: preview ? "Preview changes" : "Apply sync",
      status: "Saving settings…",
      log: "",
      done: false,
      error: null,
      mode: preview ? "preview" : "apply",
    });
    try {
      const payload = {
        ...form,
        sonarr: {
          ...form.sonarr,
          baseUrl: sonarrHubUrl || form.sonarr.baseUrl,
        },
        radarr: {
          ...form.radarr,
          baseUrl: radarrHubUrl || form.radarr.baseUrl,
        },
      };
      const saveRes = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saveJson = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveJson.error || "Save failed");

      setProgress((prev) =>
        prev
          ? {
              ...prev,
              status: preview
                ? "Starting Recyclarr preview…"
                : "Starting Recyclarr sync…",
            }
          : prev,
      );

      const res = await fetch("/api/sync/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preview,
          stream: true,
          includeQualityProfiles: profiles,
          includeQualityDefinition: sizes,
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          (json as { error?: string }).error || "Sync failed to start",
        );
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const result = await readSyncStream(
          res,
          (statusMessage) => {
            setProgress((prev) =>
              prev ? { ...prev, status: statusMessage } : prev,
            );
          },
          (chunk) => {
            setProgress((prev) =>
              prev ? { ...prev, log: prev.log + chunk } : prev,
            );
          },
        );
        if (!result.ok) throw new Error(result.error || "Sync failed");
        setProgress((prev) => {
          if (!prev) return prev;
          const streamed = prev.log || "";
          const fromServer = [result.stdout, result.stderr]
            .filter(Boolean)
            .join("\n\n");
          const combined =
            fromServer.trim().length > streamed.trim().length
              ? fromServer
              : streamed;
          return {
            ...prev,
            done: true,
            status: preview
              ? "Preview finished — choose what to apply below."
              : "Sync finished successfully.",
            log: combined,
          };
        });
        setLog((prevLog) => {
          const fromServer = [result.stdout, result.stderr]
            .filter(Boolean)
            .join("\n\n");
          return fromServer.trim() || prevLog;
        });
      } else {
        const json = await res.json();
        setLog([json.stdout, json.stderr].filter(Boolean).join("\n\n"));
        if (!json.ok) throw new Error(json.error || "Sync failed");
        setProgress((prev) =>
          prev
            ? {
                ...prev,
                done: true,
                status: "Done",
                log: [json.stdout, json.stderr].filter(Boolean).join("\n\n"),
              }
            : prev,
        );
      }

      setMessage({
        type: "ok",
        text: preview
          ? "Preview only — nothing was changed. Uncheck options you want to skip, then Apply sync."
          : "Sync finished. Check Sonarr/Radarr Profiles & Custom Formats.",
      });
      await load();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setProgress((prev) =>
        prev ? { ...prev, done: true, error: text, status: "Failed" } : prev,
      );
      setMessage({ type: "err", text });
    } finally {
      setBusy(false);
    }
  };

  const togglePreset = (id: string) => {
    setForm((prev) => {
      const selected = new Set(prev.selectedPresets);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...prev, selectedPresets: [...selected] };
    });
  };

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
    >
      <div
        className="settings-panel sync-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="sync-title"
        aria-modal="true"
      >
        <header className="settings-header">
          <h2 id="sync-title">TRaSH Sync</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close sync panel"
          >
            ✕
          </button>
        </header>

        <div className="settings-body">
          {serverUp === false && (
            <div className="sync-alert sync-alert-err">
              Sync server is not running. Start the hub with{" "}
              <code>npm run dev</code> (starts UI + sync helper).
            </div>
          )}

          {serverUp && (
            <>
              <section className="settings-group">
                <h3>Where sync runs</h3>
                <p className="settings-hint">
                  Sync runs from <strong>this PC</strong> (where the hub is
                  open). It uses your hub <strong>{modeLabel}</strong> URLs for
                  Sonarr/Radarr — no need to type them again. At work that means
                  your Remote URLs must be reachable from here (VPN, Tailscale,
                  or a domain). Paste API keys in hub <strong>Settings</strong>
                  (Sonarr/Radarr only — Recyclarr does not support Lidarr or
                  Readarr).
                </p>
                {(!sonarrKeySet || !radarrKeySet) && (
                  <p className="settings-hint">
                    {!sonarrKeySet && !radarrKeySet
                      ? "Sonarr and Radarr API keys are not set yet."
                      : !sonarrKeySet
                        ? "Sonarr API key is not set yet."
                        : "Radarr API key is not set yet."}{" "}
                    Add them under Settings → Apps &amp; monitoring.
                  </p>
                )}
                <p className="sync-status-line">
                  Active link mode: <strong>{modeLabel}</strong>
                  {" · "}
                  Recyclarr:{" "}
                  {status?.recyclarrInstalled
                    ? status.recyclarrVersion || "installed"
                    : "not installed yet"}
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={installRecyclarr}
                >
                  {status?.recyclarrInstalled
                    ? "Re-check / reinstall Recyclarr"
                    : "Download Recyclarr"}
                </button>
              </section>

              <section className="settings-group">
                <h3>Sonarr</h3>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={form.sonarr.enabled}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        sonarr: { ...prev.sonarr, enabled: e.target.checked },
                      }))
                    }
                  />
                  <span className="toggle-label">Enable Sonarr sync</span>
                </label>
                <label className="field">
                  <span>{modeLabel} URL (from hub Settings)</span>
                  <input
                    type="text"
                    value={sonarrHubUrl ?? ""}
                    readOnly
                    disabled={!form.sonarr.enabled}
                    placeholder={`No ${modeLabel} URL set for Sonarr`}
                  />
                </label>
                <p className="settings-hint">
                  API key:{" "}
                  {sonarrKeySet
                    ? "saved in Settings"
                    : "not set — add in Settings"}
                </p>
              </section>

              <section className="settings-group">
                <h3>Radarr</h3>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={form.radarr.enabled}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        radarr: { ...prev.radarr, enabled: e.target.checked },
                      }))
                    }
                  />
                  <span className="toggle-label">Enable Radarr sync</span>
                </label>
                <label className="field">
                  <span>{modeLabel} URL (from hub Settings)</span>
                  <input
                    type="text"
                    value={radarrHubUrl ?? ""}
                    readOnly
                    disabled={!form.radarr.enabled}
                    placeholder={`No ${modeLabel} URL set for Radarr`}
                  />
                </label>
                <p className="settings-hint">
                  API key:{" "}
                  {radarrKeySet
                    ? "saved in Settings"
                    : "not set — add in Settings"}
                </p>
              </section>

              <section className="settings-group">
                <h3>Profiles to sync</h3>
                <p className="settings-hint">
                  These map to TRaSH / Recyclarr templates. Start with one
                  profile per app.
                </p>
                <div className="sync-presets">
                  {presets.map((preset) => (
                    <label key={preset.id} className="sync-preset">
                      <input
                        type="checkbox"
                        checked={form.selectedPresets.includes(preset.id)}
                        onChange={() => togglePreset(preset.id)}
                      />
                      <span>
                        <strong>{preset.label}</strong>
                        <small>{preset.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="settings-group">
                <h3>Choose what to apply</h3>
                <p className="settings-hint">
                  Recommended: click <strong>Preview changes</strong> first.
                  After preview, you can still toggle these before{" "}
                  <strong>Apply sync</strong>. Uncheck quality sizes if you
                  only want profiles and custom formats.
                </p>
                <div className="sync-apply-options">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={includeQualityProfiles}
                      onChange={(e) =>
                        setIncludeQualityProfiles(e.target.checked)
                      }
                    />
                    <span className="toggle-label">
                      Quality profiles &amp; custom formats
                    </span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={includeQualityDefinition}
                      onChange={(e) =>
                        setIncludeQualityDefinition(e.target.checked)
                      }
                    />
                    <span className="toggle-label">Quality sizes</span>
                  </label>
                </div>
              </section>

              {message && (
                <div
                  className={`sync-alert ${message.type === "ok" ? "sync-alert-ok" : "sync-alert-err"}`}
                >
                  {message.text}
                </div>
              )}

              {log && (
                <section className="settings-group">
                  <h3>Log</h3>
                  <pre className="sync-log">{log}</pre>
                </section>
              )}
            </>
          )}
        </div>

        <footer className="settings-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !serverUp}
            onClick={saveSettings}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !serverUp}
            onClick={() => runSyncJob(true)}
          >
            Preview changes
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={
              busy ||
              !serverUp ||
              (!includeQualityProfiles && !includeQualityDefinition)
            }
            onClick={() =>
              void runSyncJob(false, {
                includeQualityProfiles,
                includeQualityDefinition,
              })
            }
          >
            Apply sync
          </button>
        </footer>
      </div>

      {progress && (
        <SyncProgressOverlay
          title={progress.title}
          status={progress.status}
          log={progress.log}
          done={progress.done}
          error={progress.error}
          showApply={
            progress.done && !progress.error && progress.mode === "preview"
          }
          includeQualityProfiles={includeQualityProfiles}
          includeQualityDefinition={includeQualityDefinition}
          onToggleQualityProfiles={setIncludeQualityProfiles}
          onToggleQualityDefinition={setIncludeQualityDefinition}
          onApply={() =>
            void runSyncJob(false, {
              includeQualityProfiles,
              includeQualityDefinition,
            })
          }
          onClose={() => setProgress(null)}
        />
      )}
    </div>
  );
}
