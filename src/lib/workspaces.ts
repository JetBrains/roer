/**
 * Typed bridge to the Rust Workspaces layer.
 *
 * A Workspace is a persisted, user-named entity that everything related to
 * one piece of work hangs off. Its Projects (git repos, see `./projects`)
 * are attached explicitly by id, not embedded — a Project is a global entity
 * that can be attached to several Workspaces at once. Sessions and past
 * Claude conversations are assigned by id via `assignSession`/
 * `unassignSession`, not stored on the Workspace itself.
 */
import { invoke } from "./backend";

/** A generic external item, e.g. a tracker task — no kind-specific UI yet. */
export interface WorkspaceItem {
  id: string;
  kind: string;
  title: string;
  url?: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Project ids, resolved against the global registry in `./projects`. */
  projects: string[];
  items: WorkspaceItem[];
}

export const listWorkspaces = (): Promise<Workspace[]> => invoke("workspaces_list");

export const createWorkspace = (name: string): Promise<Workspace> =>
  invoke("workspace_create", { name });

export const renameWorkspace = (id: string, name: string): Promise<Workspace | null> =>
  invoke("workspace_rename", { id, name });

export const deleteWorkspace = (id: string): Promise<void> => invoke("workspace_delete", { id });

export const attachProject = (workspaceId: string, projectId: string): Promise<Workspace | null> =>
  invoke("workspace_attach_project", { workspaceId, projectId });

export const detachProject = (workspaceId: string, projectId: string): Promise<Workspace | null> =>
  invoke("workspace_detach_project", { workspaceId, projectId });

export const addWorkspaceItem = (
  workspaceId: string,
  kind: string,
  title: string,
  url?: string,
): Promise<Workspace | null> => invoke("workspace_add_item", { workspaceId, kind, title, url });

export const removeWorkspaceItem = (
  workspaceId: string,
  itemId: string,
): Promise<Workspace | null> => invoke("workspace_remove_item", { workspaceId, itemId });

/** Session id (live session, past session, or Claude thread) → Workspace id. */
export const workspaceAssignments = (): Promise<Record<string, string>> =>
  invoke("workspace_assignments");

export const assignSession = (sessionId: string, workspaceId: string): Promise<void> =>
  invoke("workspace_assign", { sessionId, workspaceId });

export const unassignSession = (sessionId: string): Promise<void> =>
  invoke("workspace_unassign", { sessionId });
