/**
 * Typed bridge to the Rust worktree layer: a checkout of its own per task.
 * Git is the record of them, so the list is read afresh, never kept.
 */
import { invoke } from "./backend";

export interface Worktree {
  path: string;
  /** `null` when detached. */
  branch: string | null;
  /** The checked-out commit, abbreviated. */
  commit: string;
  /** The repository's main checkout, which is never removed from here. */
  main: boolean;
  /** What the branch was started from, when Roer started it. */
  base: string | null;
  locked: boolean;
  /** Its folder is not there: deleted by hand, or on a drive not mounted.
   * Git still knows it, and nothing here prunes it. */
  missing: boolean;
}

export interface CreatedWorktree {
  worktree: Worktree;
  /** The branch was already there and is only checked out. */
  existingBranch: boolean;
  /** What `.worktreeinclude` named that could not be copied. */
  warnings: string[];
}

export type WorktreeRemoval =
  | { kind: "removed"; deletedBranch: string | null; unmergedBranch: string | null }
  | { kind: "dirty"; files: string[] };

/** Every worktree of the repository `cwd` is in, the main checkout first. */
export const listWorktrees = (cwd: string): Promise<Worktree[]> => invoke("worktree_list", { cwd });

/** A new worktree named `name`, its branch started from `base` (the
 * repository's default branch without one). */
export const createWorktree = (cwd: string, name: string, base?: string): Promise<CreatedWorktree> =>
  invoke("worktree_create", { cwd, name, base: base?.trim() || null });

/** Removes a linked worktree. Without `force`, one with work in it is kept
 * and its files are handed back instead. */
export const removeWorktree = (path: string, force = false): Promise<WorktreeRemoval> =>
  invoke("worktree_remove", { path, force });

/** What removing it would lose: its uncommitted and untracked files. */
export const uncommittedInWorktree = (path: string): Promise<string[]> => invoke("worktree_uncommitted", { path });

/** Deletes a branch whatever it holds, once someone said its commits can go. */
export const deleteWorktreeBranch = (cwd: string, branch: string): Promise<void> =>
  invoke("worktree_delete_branch", { cwd, branch });
