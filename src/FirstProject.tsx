import { FolderOpen, GitBranchPlus, Download } from "lucide-react";

/**
 * Before there is any project: what one is, and the ways to the first, as
 * the one thing to do. Shown where a new person looks first, the empty stage
 * and the Workspace tab, rather than a terminal in home nobody asked for.
 */
export function FirstProject({
  onClone,
  onFolder,
  onNew,
  onHome,
  compact = false,
}: {
  onClone: () => void;
  /** A folder on disk, with a session started in it. */
  onFolder: () => void;
  onNew: () => void;
  /** A session in the home folder, without a project. */
  onHome?: () => void;
  /** One line, for someone already at work without a project: still said,
   * but not in the way of what they are doing. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <section className="notice first-project-line" aria-label="Add your first project">
        No project yet: sessions, worktrees and changes are kept by project, one git repository each.{" "}
        <button type="button" className="link" onClick={onClone}>
          Clone a repository…
        </button>{" "}
        <button type="button" className="link" onClick={onFolder}>
          Open a folder…
        </button>{" "}
        <button type="button" className="link" onClick={onNew}>
          New repository…
        </button>
      </section>
    );
  }
  return (
    <section className="first-project" aria-labelledby="first-project-title">
      <h2 id="first-project-title">Add your first project</h2>
      <p>
        A project is one git repository. Sessions start in it, and its branches, worktrees and changes are kept beside them.
        A folder of repositories becomes a workspace of them.
      </p>
      <div className="first-project-ways">
        <button type="button" className="primary" onClick={onClone}>
          <Download size={16} aria-hidden="true" />
          Clone a repository…
        </button>
        <button type="button" onClick={onFolder}>
          <FolderOpen size={16} aria-hidden="true" />
          Open a folder…
        </button>
        <button type="button" onClick={onNew}>
          <GitBranchPlus size={16} aria-hidden="true" />
          New repository…
        </button>
      </div>
      {onHome ? (
        <p className="muted">
          Or{" "}
          <button type="button" className="link" onClick={onHome}>
            start in your home folder
          </button>{" "}
          without a project.
        </p>
      ) : null}
    </section>
  );
}
