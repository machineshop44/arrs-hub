import { useEffect, useRef, useState } from "react";

interface SyncProgressOverlayProps {
  title: string;
  status: string;
  log: string;
  done: boolean;
  error: string | null;
  showApply?: boolean;
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

  return (
    <div className="progress-overlay" role="alertdialog" aria-modal="true">
      <div className={`progress-card${success ? " progress-card-success" : ""}`}>
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

        {success && (
          <div className="progress-success-banner">
            Completed successfully — review the log below, then Close.
          </div>
        )}

        <pre ref={logRef} className="progress-log" aria-live="polite">
          {log || (done ? "No log output." : "Waiting for Recyclarr output…")}
        </pre>

        <div className="progress-footer">
          {!done ? (
            <span className="progress-hint">
              Keep this popup open — ignore any brief console flash. Status
              updates here.
            </span>
          ) : (
            <div className="progress-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void copyText()}
              >
                {copied ? "Copied!" : "Copy log"}
              </button>
              {showApply && onApply && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onApply}
                >
                  Apply sync
                </button>
              )}
              <button
                type="button"
                className={showApply ? "btn btn-secondary" : "btn btn-primary"}
                onClick={onClose}
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
