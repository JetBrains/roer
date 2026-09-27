/**
 * Typed bridge to the Rust Projects registry.
 *
 * A Project is a global entity (a git repository), independent of any one
 * Workspace — the many-to-many attachment lives on `Workspace.projects` as a
 * list of Project ids (see `./workspaces`), not here.
 */
import { invoke } from "./backend";

export interface Project {
  id: string;
  path: string;
  name: string;
}

export const listProjects = (): Promise<Project[]> => invoke("projects_list");

/** Reuses the existing Project when `path` is already registered. */
export const createProject = (name: string, path: string): Promise<Project> =>
  invoke("project_create", { name, path });

export const renameProject = (id: string, name: string): Promise<Project | null> =>
  invoke("project_rename", { id, name });

/** Removes the Project everywhere — its own registry entry, and every
 * Workspace's reference to it. */
export const deleteProject = (id: string): Promise<void> => invoke("project_delete", { id });
