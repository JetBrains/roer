import { ask, open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Project } from "./lib/projects";

export interface ProjectsPanelProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string, path: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

/** Just the directory's own name, used as a new Project's starting name. */
function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/**
 * The Projects tab of the sidebar: every registered git repository,
 * independent of which Workspace (if any) it is attached to. Attaching a
 * Project to a Workspace happens from the Sessions view instead — this is
 * just the global registry: create, rename, delete.
 */
export function ProjectsPanel({
  projects,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: ProjectsPanelProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const addProject = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") onCreate(folderName(picked), picked);
  };

  const startRename = (project: Project) => {
    setRenamingId(project.id);
    setRenameValue(project.name);
  };

  const submitRename = () => {
    const trimmed = renameValue.trim();
    if (renamingId && trimmed) onRename(renamingId, trimmed);
    setRenamingId(null);
  };

  const confirmDelete = async (project: Project) => {
    const confirmed = await ask(`Delete "${project.name}"? This removes it from every Workspace.`, {
      title: "Delete project",
      kind: "warning",
    });
    if (confirmed) onDelete(project.id);
  };

  return (
    <div className="workspace-switcher">
      <h2>
        Projects
        <button type="button" className="link" onClick={() => void addProject()}>
          New project
        </button>
      </h2>

      {projects.length === 0 ? (
        <p className="muted">No projects yet.</p>
      ) : (
        <ul>
          {projects.map((project) => {
            const active = project.id === selectedId;
            if (renamingId === project.id) {
              return (
                <li key={project.id}>
                  <div className="workspace-form">
                    <input
                      type="text"
                      className="workspace-input"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitRename();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="primary"
                      disabled={!renameValue.trim()}
                      onClick={submitRename}
                    >
                      Save
                    </button>
                  </div>
                </li>
              );
            }
            return (
              <li key={project.id}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      className={active ? "row wrap active" : "row wrap"}
                      aria-pressed={active}
                      title={project.path}
                      onClick={() => onSelect(project.id)}
                    >
                      <strong>{project.name}</strong>
                      <span className="muted">{project.path}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => startRename(project)}>Rename</ContextMenuItem>
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => void confirmDelete(project)}
                    >
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
