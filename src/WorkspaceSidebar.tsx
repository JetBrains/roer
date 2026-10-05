import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

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
  | "handleAttachExistingProject"
  | "handleAttachNewProject"
  | "handleCreateProject"
  | "handleRenameProject"
  | "handleDeleteProject"
> & {
  setSelectedWorkspaceId: (id: string | null) => void;
  /** Collapsed to a sliver by the toggle in the title bar. Stays mounted so
   * the Workspaces/Projects tab choice survives being reopened. */
  collapsed: boolean;
  /** What goes below the picker: the tree of running sessions. */
  children?: ReactNode;
};

/**
 * The left column: which Workspace or Project is selected, and below it the
 * sessions running there. The picker is one line, folded open to switch or
 * manage them, since that is done once in a while and the sessions are
 * looked at all the time. "Workspaces" and "Projects" are two tabs of one
 * list, not two panels fighting for space at once.
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
  handleAttachExistingProject,
  handleAttachNewProject,
  handleCreateProject,
  handleRenameProject,
  handleDeleteProject,
  collapsed,
  children,
}: WorkspaceSidebarProps) {
  const [tab, setTab] = useState<"workspaces" | "projects">("workspaces");
  const [picking, setPicking] = useState(false);
  const selectedName =
    projects.find((project) => project.id === selectedProjectId)?.name ??
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
      ?.name ??
    "Workspaces";
  const selectedKind = selectedProjectId ? "Project" : "Workspace";

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

      <button
        type="button"
        className={picking ? "scope-picker open" : "scope-picker"}
        aria-expanded={picking}
        aria-label="Switch Workspace or Project"
        title={`${selectedKind}: ${selectedName}`}
        onClick={() => setPicking((open) => !open)}
      >
        {picking ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        <strong>{selectedName}</strong>
        <span className="muted">{selectedKind}</span>
      </button>

      {picking ? (
        <div className="scope-panel">
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
              projects={projects}
              selectedId={selectedWorkspaceId}
              onSelect={(id) => {
                setSelectedWorkspaceId(id);
                setPicking(false);
              }}
              onCreate={handleCreateWorkspace}
              onRename={handleRenameWorkspace}
              onDelete={handleDeleteWorkspace}
              onAttachProject={handleAttachExistingProject}
              onAttachNewProject={handleAttachNewProject}
            />
          ) : (
            <ProjectsPanel
              projects={projects}
              selectedId={selectedProjectId}
              onSelect={(id) => {
                setSelectedProjectId(id);
                setPicking(false);
              }}
              onCreate={handleCreateProject}
              onRename={handleRenameProject}
              onDelete={handleDeleteProject}
            />
          )}
        </div>
      ) : null}

      {children}

      {failure ? <p className="error">{failure}</p> : null}

      {status && !status.available ? (
        <p className="error">
          The <code>roer</code> command was not found (looked for{" "}
          <code>{status.bin}</code>). Install it from a release&apos;s CLI
          tarball into <code>~/.local/bin</code>, or point <code>ROER_BIN</code>{" "}
          at a build: <code>cargo build --manifest-path cli/Cargo.toml</code>{" "}
          makes <code>cli/target/debug/roer</code>.
        </p>
      ) : null}
    </nav>
  );
}
