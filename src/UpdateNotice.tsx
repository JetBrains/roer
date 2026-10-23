import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { openUrl } from "./lib/github";
import { installUpdate, onUpdateProgress, skipUpdate, type UpdateProgress, type UpdateStatus } from "./lib/updates";

/** What the notice says while the update is under way. */
function describe(version: string, progress: UpdateProgress | null): string {
  switch (progress?.stage) {
    case undefined:
    case "download": {
      const received = progress?.received ?? 0;
      const total = progress?.total;
      if (total) return `Downloading Roer ${version}… ${Math.min(100, Math.floor((received / total) * 100))}%`;
      return `Downloading Roer ${version}… ${(received / 1_000_000).toFixed(0)} MB`;
    }
    case "verify":
      return `Checking Roer ${version}…`;
    case "install":
      return `Installing Roer ${version}…`;
    case "restart":
      return "Restarting Roer…";
  }
}

/**
 * A newer Roer is out: one line in a corner rather than in the way. Where the
 * app can replace itself, one button downloads it, checks it and restarts
 * into it; sessions run in tmux, so they carry on. Elsewhere, or once that
 * fails, it offers the release's page. The cross puts it off until the next
 * check, "Skip" until a later version.
 */
export function UpdateNotice({ update, onClose }: { update: UpdateStatus; onClose: () => void }) {
  const [state, setState] = useState<
    { kind: "offered" } | { kind: "installing"; progress: UpdateProgress | null } | { kind: "failed"; error: string }
  >({ kind: "offered" });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void onUpdateProgress((progress) =>
      setState((now) => (now.kind === "installing" ? { kind: "installing", progress } : now)),
    )
      .then((fn) => {
        if (gone) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  const download = () => {
    void openUrl(update.url).catch(() => undefined);
    onClose();
  };
  const install = () => {
    setState({ kind: "installing", progress: null });
    installUpdate(update.latest).catch((cause: unknown) => setState({ kind: "failed", error: String(cause) }));
  };

  if (state.kind === "installing") {
    return (
      <div className="update-notice" role="status" aria-label="Updating">
        <span className="update-notice-text">{describe(update.latest, state.progress)}</span>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="update-notice" role="alert" aria-label="Update failed">
        <span className="update-notice-text" title={state.error}>
          Could not update: {state.error}
        </span>
        <button type="button" className="link" onClick={download}>
          Download
        </button>
        <button type="button" className="update-notice-close" aria-label="Close" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="update-notice" role="status" aria-label="Update available">
      <span className="update-notice-text" title={`You have ${update.current}`}>
        Roer {update.latest} is available
      </span>
      {update.canInstall ? (
        <button type="button" className="link" title="Sessions keep running" onClick={install}>
          Update and restart
        </button>
      ) : (
        <button type="button" className="link" onClick={download}>
          Download
        </button>
      )}
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
