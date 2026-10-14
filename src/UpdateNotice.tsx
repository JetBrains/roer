import { X } from "lucide-react";

import { openUrl } from "./lib/github";
import { skipUpdate, type UpdateStatus } from "./lib/updates";

/**
 * A newer Roer is out: one line in a corner rather than in the way. The
 * cross puts it off until the next check, "Skip" until a later version.
 */
export function UpdateNotice({ update, onClose }: { update: UpdateStatus; onClose: () => void }) {
  return (
    <div className="update-notice" role="status" aria-label="Update available">
      <span className="update-notice-text" title={`You have ${update.current}`}>
        Roer {update.latest} is available
      </span>
      <button
        type="button"
        className="link"
        onClick={() => {
          void openUrl(update.url).catch(() => undefined);
          onClose();
        }}
      >
        Download
      </button>
      <button
        type="button"
        className="link muted"
        title="Don't offer this version again"
        onClick={() => {
          void skipUpdate(update.latest).catch(() => undefined);
          onClose();
        }}
      >
        Skip
      </button>
      <button type="button" className="update-notice-close" aria-label="Later" title="Later" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
