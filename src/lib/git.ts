/**
 * Typed bridge to the Rust git layer.
 *
 * The backend answers about one repository at a time — the one the staged
 * session is sitting in — so every call carries the directory it is about.
 */
import { invoke } from "./backend";

export interface FileChange {
  /** Repo-relative and slash-separated. */
  path: string;
  /** Index status letter: `.` when the index matches HEAD. */
  staged: string;
  /** Worktree status letter: `.` when clean, `?` when untracked. */
  unstaged: string;
  added: number;
  deleted: number;
  renamedFrom?: string | null;
  binary: boolean;
  /** False when nobody could count the lines, so `added` means nothing. */
  counted: boolean;
}

export interface Changes {
  root: string;
  branch: string;
  files: FileChange[];
}

export const gitChanges = (cwd: string): Promise<Changes> => invoke("git_changes", { cwd });

/** Where a directory sits among its repository's worktrees. */
export interface Repo {
  /** The checkout it is in: a linked worktree's own folder. */
  root: string;
  /** The repository's main checkout, the same from every worktree. */
  main: string;
  /** Every worktree, the main checkout first. */
  worktrees: string[];
}

/** Which repository a directory is in, whichever worktree; `null` outside one. */
export const gitRepo = (cwd: string): Promise<Repo | null> => invoke("git_repo", { cwd });

/** The repository a directory sits in, or `null` outside one. */
export const gitRoot = (cwd: string): Promise<string | null> => invoke("git_root", { cwd });

export const gitDiff = (root: string, path: string, untracked: boolean): Promise<string> =>
  invoke("git_diff", { root, path, untracked });

/** One commit, as much as the branch-diff view names it by. */
export interface Commit {
  hash: string;
  short: string;
  author: string;
  /** Unix seconds, author date. */
  date: number;
  subject: string;
}

/** Every local branch, for the branch-diff view's two pickers. */
export const gitBranches = (cwd: string): Promise<string[]> => invoke("git_branches", { cwd });

/** The session's own branch, the sensible default for "which branch". */
export const gitCurrentBranch = (cwd: string): Promise<string> =>
  invoke("git_current_branch", { cwd });

/** Every commit `branch` has that `base` does not, oldest first. */
export const gitBranchCommits = (
  root: string,
  branch: string,
  base: string,
): Promise<Commit[]> => invoke("git_branch_commits", { root, branch, base });

/** The files one commit touched, diffed against its own parent. */
export const gitCommitFiles = (root: string, commit: string): Promise<FileChange[]> =>
  invoke("git_commit_files", { root, commit });

/** One commit's unified diff of a single file, against its own parent. */
export const gitCommitDiff = (root: string, commit: string, path: string): Promise<string> =>
  invoke("git_commit_diff", { root, commit, path });

/** True for a file git has never seen, which is diffed differently. */
export const isUntracked = (file: FileChange): boolean => file.unstaged === "?";

/**
 * The single letter to show for a row. The index side wins when both have
 * something, because that is the change that is about to be committed.
 */
export function statusLetter(file: FileChange): string {
  if (file.unstaged === "?") return "A";
  const letter = file.staged !== "." ? file.staged : file.unstaged;
  return letter === "." ? "M" : letter;
}

/** What git did to the file, as an IDE labels it above the diff. */
export function changeKind(file: FileChange): string {
  if (isUntracked(file)) return "new";
  return (
    { A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict" }[statusLetter(file)] ??
    "modified"
  );
}

/** Whether anything is staged, which the row shows as a separate mark. */
export const isStaged = (file: FileChange): boolean => file.staged !== "." && file.staged !== "?";
