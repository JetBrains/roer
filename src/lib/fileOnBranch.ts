/**
 * Where a view's file opens when the view is about a branch: the worktree that has the branch checked out, so the
 * tab is the live file with its local changes, or else the repository's main checkout with the branch named, so
 * the file is read from git as the branch has it.
 */
import type { FileTab } from "./tabs";
import { listWorktrees } from "./worktrees";

export async function fileOnBranch(
  root: string,
  path: string,
  line: number | undefined,
  branch: string | undefined,
): Promise<FileTab> {
  const tab: FileTab = { kind: "file", root, path, ...(line === undefined ? {} : { line }) };
  if (!branch) return tab;
  const worktrees = await listWorktrees(root).catch(() => []);
  const checkedOut = worktrees.find((one) => one.branch === branch && !one.missing);
  if (checkedOut) return { ...tab, root: checkedOut.path };
  if (worktrees.length === 0) return { ...tab, branch };
  const main = worktrees.find((one) => one.main && !one.missing);
  return { ...tab, root: main?.path ?? root, branch };
}
