/**
 * Where a view's file opens when the view is about a branch: the worktree that has the branch checked out, so the
 * tab is the live file with its local changes, or else the repository's main checkout with the branch named, so
 * the file is read from git as the branch has it.
 */
import type { FileTab } from "./tabs";
import { listWorktrees } from "./worktrees";

/** A whole object id: the content a thread was written on, given in place of a branch. */
export const isObjectId = (text: string): boolean => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text);

export async function fileOnBranch(
  root: string,
  path: string,
  line: number | undefined,
  branch: string | undefined,
): Promise<FileTab> {
  const tab: FileTab = { kind: "file", root, path, ...(line === undefined ? {} : { line }) };
  if (!branch) return tab;
  // A blob (the content a thread was written on) is the same in every checkout: read where the tab already is.
  if (isObjectId(branch)) return { ...tab, branch };
  const worktrees = await listWorktrees(root).catch(() => []);
  const checkedOut = worktrees.find((one) => one.branch === branch && !one.missing);
  if (checkedOut) return { ...tab, root: checkedOut.path };
  if (worktrees.length === 0) return { ...tab, branch };
  const main = worktrees.find((one) => one.main && !one.missing);
  return { ...tab, root: main?.path ?? root, branch };
}
