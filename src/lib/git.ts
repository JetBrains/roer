/**
 * Typed bridge to the Rust git layer.
 *
 * The backend answers about one repository at a time — the one the staged
 * session is sitting in — so every call carries the directory it is about.
 */
import { invoke } from "@tauri-apps/api/core";

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

/** The repository a directory sits in, or `null` outside one. */
export const gitRoot = (cwd: string): Promise<string | null> => invoke("git_root", { cwd });

export const gitDiff = (root: string, path: string, untracked: boolean): Promise<string> =>
  invoke("git_diff", { root, path, untracked });

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
