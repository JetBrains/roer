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

export interface Workspace {
  id: string;
  name: string;
  /** Project ids, resolved against the global registry in `./projects`. */
  projects: string[];
  /** The folder it stands for, such as the folder of repositories it was
   * made from: what is there outside its Projects is still its own. */
  folder?: string;
}

export const listWorkspaces = (): Promise<Workspace[]> => invoke("workspaces_list");

export const createWorkspace = (name: string): Promise<Workspace> =>
  invoke("workspace_create", { name });

export const renameWorkspace = (id: string, name: string): Promise<Workspace | null> =>
  invoke("workspace_rename", { id, name });

/** Sets the folder, or clears it with `null`. */
export const setWorkspaceFolder = (id: string, folder: string | null): Promise<Workspace | null> =>
  invoke("workspace_set_folder", { id, folder });

export const deleteWorkspace = (id: string): Promise<void> => invoke("workspace_delete", { id });

export const attachProject = (workspaceId: string, projectId: string): Promise<Workspace | null> =>
  invoke("workspace_attach_project", { workspaceId, projectId });

export const detachProject = (workspaceId: string, projectId: string): Promise<Workspace | null> =>
  invoke("workspace_detach_project", { workspaceId, projectId });

/** Session id (live session, past session, or Claude thread) → Workspace id. */
export const workspaceAssignments = (): Promise<Record<string, string>> =>
  invoke("workspace_assignments");

export const assignSession = (sessionId: string, workspaceId: string): Promise<void> =>
  invoke("workspace_assign", { sessionId, workspaceId });

export const unassignSession = (sessionId: string): Promise<void> =>
  invoke("workspace_unassign", { sessionId });
