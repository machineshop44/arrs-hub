import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

interface SyncProgressOverlayProps {
  title: string;
  status: string;
  log: string;
  done: boolean;
  error: string | null;
  showApply?: boolean;
  includeQualityProfiles: boolean;
  includeQualityDefinition: boolean;
  onToggleQualityProfiles: (value: boolean) => void;
  onToggleQualityDefinition: (value: boolean) => void;
  onApply?: () => void;
  onClose: () => void;
}

export function SyncProgressOverlay({
  title,
  status,
  log,
  done,
  error,
  showApply = false,
  includeQualityProfiles,
  includeQualityDefinition,
  onToggleQualityProfiles,
  onToggleQualityDefinition,
  onApply,
  onClose,
}: SyncProgressOverlayProps) {
  const logRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const success = done && !error;

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyText = async () => {
    const body =
      log.trim() ||
      (done ? "No log output." : "Waiting for Recyclarr output…");
    const text = [title, error || status, "", body].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      setCopied(true);
    }
  };

  const handleApply = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onApply?.();
  };

  const handleClose = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const overlay = (
    <div
      className="progress-overlay"
      role="alertdialog"
      aria-modal="true"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className={`progress-card${success ? " progress-card-success" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="progress-header">
          {!done && <span className="progress-spinner" aria-hidden="true" />}
          {success && (
            <span className="progress-check" aria-hidden="true">
              ✓
            </span>
          )}
          <div>
            <h3>{title}</h3>
            <p
              className={
                error
                  ? "progress-status err"
                  : success
                    ? "progress-status ok"
                    : "progress-status"
              }
            >
              {error || status}
            </p>
          </div>
        </div>

        {success && showApply && (
          <div className="progress-success-banner">
            Pending changes are listed below. Uncheck anything you do not want
            written (for example quality sizes), then click{" "}
            <strong>Apply sync</strong>.
            <div className="sync-apply-options">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={includeQualityProfiles}
                  onChange={(e) => onToggleQualityProfiles(e.target.checked)}
                />
                <span className="toggle-label">
                  Quality profiles &amp; custom formats
                </span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={includeQualityDefinition}
                  onChange={(e) => onToggleQualityDefinition(e.target.checked)}
                />
                <span className="toggle-label">Quality sizes</span>
              </label>
            </div>
          </div>
        )}

        {success && !showApply && (
          <div className="progress-success-banner">
            Completed successfully — review the activity log below, then Close.
          </div>
        )}

        {error && (
          <div className="progress-error-banner">
            Sync failed — see the log below for details.
          </div>
        )}

        <pre ref={logRef} className="progress-log" aria-live="polite">
          {log || (done ? "No log output." : "Waiting for Recyclarr output…")}
        </pre>

        <div className="progress-footer">
          {!done ? (
            <span className="progress-hint">
              Keep this popup open — status and Recyclarr activity appear here.
              A brief console flash on Windows is normal.
            </span>
          ) : (
            <div className="progress-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  void copyText();
                }}
              >
                {copied ? "Copied!" : "Copy log"}
              </button>
              {showApply && onApply && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!includeQualityProfiles && !includeQualityDefinition}
                  onClick={handleApply}
                >
                  Apply sync
                </button>
              )}
              <button
                type="button"
                className={showApply ? "btn btn-secondary" : "btn btn-primary"}
                onClick={handleClose}
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
