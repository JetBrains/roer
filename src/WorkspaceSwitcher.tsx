import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { type Workspace } from "./lib/workspaces";

export interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  /** `null` means "All" — every session and conversation, unfiltered. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

/**
 * The top half of the sidebar: which Workspace's sessions and conversations
 * the bottom half is showing. Selecting none is "All", the flat list this
 * app had before Workspaces existed — additive, not a forced migration.
 */
export function WorkspaceSwitcher({
  workspaces,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: WorkspaceSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setName("");
    setCreating(false);
  };

  const startRename = (workspace: Workspace) => {
    setRenamingId(workspace.id);
    setRenameValue(workspace.name);
  };

  const submitRename = () => {
    const trimmed = renameValue.trim();
    if (renamingId && trimmed) onRename(renamingId, trimmed);
    setRenamingId(null);
  };

  return (
    <div className="workspace-switcher">
      <h2>
        Workspaces
        <button
          type="button"
          className="link"
          onClick={() => setCreating((wasCreating) => !wasCreating)}
        >
          {creating ? "Cancel" : "New workspace"}
        </button>
      </h2>

      {creating ? (
        <div className="workspace-form">
          <input
            type="text"
            className="workspace-input"
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          <button type="button" className="primary" disabled={!name.trim()} onClick={submit}>
            Create
          </button>
        </div>
      ) : null}

      <ul>
        <li>
          <button
            type="button"
            className={selectedId === null ? "row active" : "row"}
            aria-pressed={selectedId === null}
            onClick={() => onSelect(null)}
          >
            <strong>All</strong>
          </button>
        </li>
        {workspaces.map((workspace) => {
          const active = workspace.id === selectedId;
          if (renamingId === workspace.id) {
            return (
              <li key={workspace.id}>
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
            <li key={workspace.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className={active ? "row active" : "row"}
                    aria-pressed={active}
                    onClick={() => onSelect(workspace.id)}
                  >
                    <strong>{workspace.name}</strong>
                    <span className="muted">
                      {workspace.projects.length === 1
                        ? "1 project"
                        : `${workspace.projects.length} projects`}
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => startRename(workspace)}>
                    Rename
                  </ContextMenuItem>
                  <ContextMenuItem variant="destructive" onSelect={() => onDelete(workspace.id)}>
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
