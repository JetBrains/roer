import { useEffect, useRef, useState } from "react";

import type { FolderRepos } from "./lib/useSessionBrowser";

/** A path's last part. */
const nameOf = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * A folder picked as a project that is not a git repository but holds some.
 * A project is one repository, so the folder becomes a Workspace of them,
 * or more of the Workspace it was picked for: each repository it holds, the
 * ones left ticked, becomes a project of that.
 */
export function FolderReposDialog({
  asked,
  workspaceName,
  onConfirm,
  onClose,
}: {
  asked: FolderRepos;
  /** The Workspace it was picked for, when there is one to offer. */
  workspaceName?: string;
  onConfirm: (repos: string[], into: "new" | "same") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(asked.repos));
  const folder = nameOf(asked.path);
  const inside = (repo: string) => repo.slice(asked.path.replace(/\/+$/, "").length + 1) || nameOf(repo);
  const picked = asked.repos.filter((repo) => chosen.has(repo));

  useEffect(() => {
    const back = document.activeElement;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const toggle = (repo: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(repo);
      else next.delete(repo);
      return next;
    });

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup setup folder-choice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-repos-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2 id="folder-repos-title">{folder} holds {asked.repos.length === 1 ? "a git repository" : `${asked.repos.length} git repositories`}</h2>
        <p>
          A project in Roer is one git repository, with its own branches, worktrees and changes.{" "}
          {asked.forFolder && workspaceName
            ? `Make each of these one of ${workspaceName}'s.`
            : "Make each of these one, grouped in a workspace."}
          {asked.session ? <> The session starts in <code>{folder}</code>, where its agent can reach them all.</> : null}
        </p>

        {asked.repos.length > 1 ? (
          // Many at once, from a folder of everything, is easier picked from none.
          <button
            type="button"
            className="link folder-repos-all"
            onClick={() => setChosen(picked.length === asked.repos.length ? new Set() : new Set(asked.repos))}
          >
            {picked.length === asked.repos.length ? "Select none" : "Select all"}
          </button>
        ) : null}

        <div className="folder-repos">
          {asked.repos.map((repo) => (
            <label key={repo} className="setup-option" title={repo}>
              <input type="checkbox" checked={chosen.has(repo)} onChange={(event) => toggle(repo, event.target.checked)} />
              <span>{inside(repo)}</span>
            </label>
          ))}
        </div>

        <div className="setup-actions">
          <button type="button" onClick={onClose}>
            {asked.forFolder ? "Not now" : "Cancel"}
          </button>
          {asked.forFolder && workspaceName ? (
            // The folder is already this Workspace's: a new one would be a second.
            <button type="button" className="primary" disabled={picked.length === 0} autoFocus onClick={() => onConfirm(picked, "same")}>
              Add to {workspaceName}
            </button>
          ) : (
            <>
              {workspaceName ? (
                <button type="button" disabled={picked.length === 0} onClick={() => onConfirm(picked, "same")}>
                  Add to {workspaceName}
                </button>
              ) : null}
              <button type="button" className="primary" disabled={picked.length === 0} autoFocus onClick={() => onConfirm(picked, "new")}>
                Create workspace {folder}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
