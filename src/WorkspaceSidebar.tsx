import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  | "openNew"
  | "pickingProjectFor"
  | "cancelProjectPick"
  | "pickProjectForNewSession"
  | "attachNewProjectForNewSession"
> & {
  /** Not the hook's raw setter: `App` wraps it to also switch the stage to
   * the Sessions tab, so picking a Workspace always shows what it filters. */
  setSelectedWorkspaceId: (id: string | null) => void;
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
  openNew,
  pickingProjectFor,
  cancelProjectPick,
  pickProjectForNewSession,
  attachNewProjectForNewSession,
}: WorkspaceSidebarProps) {
  const [tab, setTab] = useState<"workspaces" | "projects">("workspaces");

  const pickedProjects = pickingProjectFor
    ? pickingProjectFor.projects
        .map((id) => projects.find((project) => project.id === id))
        .filter((project): project is (typeof projects)[number] => project != null)
    : [];

  const attachNewForPicker = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      attachNewProjectForNewSession(picked);
    } else {
      // The dialog was dismissed — nothing was picked, so nothing else in
      // this flow will close the menu for us.
      cancelProjectPick();
    }
  };

  return (
    <nav className="sidebar" aria-label="Workspaces">
      <header>
        <h1>Roer</h1>
        <DropdownMenu
          open={pickingProjectFor != null}
          onOpenChange={(next) => {
            if (!next) cancelProjectPick();
          }}
        >
          <DropdownMenuTrigger asChild>
            <button type="button" className="primary" onClick={openNew}>
              New session
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {pickedProjects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => pickProjectForNewSession(project.path)}
              >
                {project.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onSelect={(event) => {
                // The dialog is async and the Workspace it's for only lives
                // in `pickingProjectFor` — letting Radix's default close
                // through here would clear it before the dialog resolves.
                event.preventDefault();
                void attachNewForPicker();
              }}
            >
              Attach a new project…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
          The <code>roer</code> shim was not found (looked for <code>{status.bin}</code>). Link it
          with <code>ln -s $PWD/scripts/roer ~/.local/bin/roer</code>, or point{" "}
          <code>ROER_BIN</code> at it.
        </p>
      ) : null}
    </nav>
  );
}
