import type { TrashUpdatesSnapshot } from "../trashUpdates";

interface TrashUpdateBannerProps {
  snapshot: TrashUpdatesSnapshot;
  onDismiss: () => void;
  onOpenGuides: () => void;
  onOpenSync?: () => void;
}

export function TrashUpdateBanner({
  snapshot,
  onDismiss,
  onOpenGuides,
  onOpenSync,
}: TrashUpdateBannerProps) {
  const latest = snapshot.recent[0];

  return (
    <aside className="trash-banner" role="status">
      <div className="trash-banner-main">
        <div className="trash-banner-title">
          <span className="trash-banner-badge">Update</span>
          <strong>TRaSH Guides has new changes</strong>
        </div>
        <p className="trash-banner-meta">
          Latest: {latest?.date ?? snapshot.commit.date.slice(0, 10)} — open{" "}
          <strong>Sync</strong>, run <strong>Preview changes</strong>, then
          uncheck anything you do not want (for example quality sizes) before{" "}
          <strong>Apply sync</strong>. Or review the guides manually.
        </p>
        {latest && (
          <ul className="trash-banner-list">
            {latest.items.slice(0, 4).map((item) => (
              <li key={item.url}>
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="trash-banner-actions">
        {onOpenSync && (
          <button type="button" className="btn btn-primary" onClick={onOpenSync}>
            Open Sync
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onOpenGuides}>
          Open guides
        </button>
        <a
          className="btn btn-secondary"
          href={snapshot.changelogUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Full changelog
        </a>
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          Mark as reviewed
        </button>
      </div>
    </aside>
  );
}
