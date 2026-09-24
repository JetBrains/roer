import { useState } from "react";

import type { SessionBrowserState } from "./lib/useSessionBrowser";
import { ProjectsPanel } from "./ProjectsPanel";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export type WorkspaceSidebarProps = Pick<
  SessionBrowserState,
  | "status"
  | "failure"
  | "workspaces"
  | "projects"
  | "selectedWorkspaceId"
  | "selectedProjectId"
  | "setSelectedProjectId"
  | "handleCreateWorkspace"
  | "handleRenameWorkspace"
  | "handleDeleteWorkspace"
  | "handleCreateProject"
  | "handleRenameProject"
  | "handleDeleteProject"
> & {
  /** Not the hook's raw setter: `App` wraps it to also switch the stage to
   * the Sessions tab, so picking a Workspace always shows what it filters. */
  setSelectedWorkspaceId: (id: string | null) => void;
  /** Collapsed to a sliver by the toggle in the title bar. Stays mounted so
   * the Workspaces/Projects tab choice survives being reopened. */
  collapsed: boolean;
};

/**
 * The left column: which Workspace or Project is selected, kept apart from
 * the sessions and conversations that selection filters — those are the
 * point of the right side, not a thing this switcher needs room for.
 * "Workspaces" and "Projects" are two tabs of one list, not two panels
 * fighting for space at once.
 */
export function WorkspaceSidebar({
  status,
  failure,
  workspaces,
  projects,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  selectedProjectId,
  setSelectedProjectId,
  handleCreateWorkspace,
  handleRenameWorkspace,
  handleDeleteWorkspace,
  handleCreateProject,
  handleRenameProject,
  handleDeleteProject,
  collapsed,
}: WorkspaceSidebarProps) {
  const [tab, setTab] = useState<"workspaces" | "projects">("workspaces");

  return (
    <nav
      className={collapsed ? "sidebar collapsed" : "sidebar"}
      aria-label="Workspaces"
      aria-hidden={collapsed}
      inert={collapsed}
    >
      <header>
        <h1>Roer</h1>
      </header>

      <div className="workspace-tabs" role="tablist" aria-label="Sidebar">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "workspaces"}
          className={tab === "workspaces" ? "tab on" : "tab"}
          onClick={() => setTab("workspaces")}
        >
          Workspaces
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "projects"}
          className={tab === "projects" ? "tab on" : "tab"}
          onClick={() => setTab("projects")}
        >
          Projects
        </button>
      </div>

      {tab === "workspaces" ? (
        <WorkspaceSwitcher
          workspaces={workspaces}
          selectedId={selectedWorkspaceId}
          onSelect={setSelectedWorkspaceId}
          onCreate={handleCreateWorkspace}
          onRename={handleRenameWorkspace}
          onDelete={handleDeleteWorkspace}
        />
      ) : (
        <ProjectsPanel
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
          onCreate={handleCreateProject}
          onRename={handleRenameProject}
          onDelete={handleDeleteProject}
        />
      )}

      {failure ? <p className="error">{failure}</p> : null}

      {status && !status.available ? (
        <p className="error">
          The <code>roer</code> command was not found (looked for <code>{status.bin}</code>).
          Install it from a release&apos;s CLI tarball into <code>~/.local/bin</code>, or point{" "}
          <code>ROER_BIN</code> at a build: <code>cargo build --manifest-path cli/Cargo.toml</code>{" "}
          makes <code>cli/target/debug/roer</code>.
        </p>
      ) : null}
    </nav>
  );
}
