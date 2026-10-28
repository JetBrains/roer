import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { confirmAction } from "./lib/confirm";
import type { Project } from "./lib/projects";

export interface ProjectsPanelProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The Add project dialog. */
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

/** How many projects there are before the tab offers to search them. */
const SEARCH_FROM = 6;

/**
 * The Projects tab of the sidebar: every registered git repository,
 * independent of which Workspace (if any) it is attached to. Attaching a
 * Project to a Workspace happens from the Workspace tab instead — this is
 * just the global registry: create, rename, delete.
 */
export function ProjectsPanel({
  projects,
  selectedId,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: ProjectsPanelProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // Newest first: the registry keeps them in the order they came, and the
  // one just added is the one looked for.
  const shown = projects
    .filter((project) => !needle || `${project.name} ${project.path}`.toLowerCase().includes(needle))
    .reverse();

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
    const confirmed = await confirmAction(`Delete "${project.name}"? This removes it from every Workspace.`, "Delete project");
    if (confirmed) onDelete(project.id);
  };

  return (
    <div className="workspace-switcher">
      <h2>
        Projects
        <button type="button" className="link" onClick={onAdd}>
          Add project
        </button>
      </h2>

      {projects.length > SEARCH_FROM ? (
        <input
          type="search"
          className="workspace-input projects-search"
          placeholder="Search projects"
          aria-label="Search projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}

      {projects.length === 0 ? (
        <p className="muted">No projects yet.</p>
      ) : shown.length === 0 ? (
        <p className="muted">None match.</p>
      ) : (
        <ul>
          {shown.map((project) => {
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
