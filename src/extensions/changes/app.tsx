import { useCallback } from "react";
import {
  adoptLocal,
  defineExtension,
  gitCommitDiff,
  gitCommitFiles,
  gitDiff,
  isUntracked,
  useActivateTab,
  useActive,
  useSession,
  type Commit,
  type FileChange,
  type CopyCall,
} from "roer";

import { ChangesView } from "./ChangesView";
import { REVIEW_PREFIX } from "./local";
import { addCommentsTool } from "./tool";

/** How many of a branch's commits a saved copy holds file by file: a long branch must not make a huge file. */
const COPY_COMMITS = 50;

/**
 * What a saved copy of Changes holds beyond what it drew on its own: every uncommitted file's diff, and every
 * commit's files and their diffs, fetched with what the tab fetched (the same repository, commits and paths), so
 * the copy finds them when they are clicked. Not the files whole, which only expanding context needs.
 */
async function prepareCopy(seen: (command: string) => readonly CopyCall[]): Promise<void> {
  const reads: Array<Promise<unknown>> = [];
  for (const call of seen("git_changes")) {
    const local = call.value as { root: string; files: FileChange[] };
    for (const file of local.files) reads.push(gitDiff(local.root, file.path, isUntracked(file)).catch(() => null));
  }
  await Promise.all(reads);
  for (const call of seen("git_branch_commits")) {
    const root = String(call.args.root);
    for (const commit of (call.value as Commit[]).slice(0, COPY_COMMITS)) {
      const files = await gitCommitFiles(root, commit.hash).catch(() => []);
      await Promise.all(files.map((file) => gitCommitDiff(root, commit.hash, file.path).catch(() => null)));
    }
  }
}

/** The Changes tab: the session's branch, its edits and commits, the whole of it with comments on its lines, and
 * its pull request from opening it to merging it, with the review threads and what to do about each comment. */
export default defineExtension((roer) => {
  // Reviews kept in this view's own storage before they were shared with the others.
  adoptLocal(REVIEW_PREFIX);

  function Changes() {
    const session = useSession();
    const active = useActive();
    const activateTab = useActivateTab();
    // The strip shows how many comments still wait on a decision.
    const onOpenCount = useCallback((count: number) => roer.badge.set("changes", count > 0 ? String(count) : null), []);
    return (
      <ChangesView
        session={session}
        active={active}
        onSent={() => activateTab("terminal")}
        onOpenCount={onOpenCount}
      />
    );
  }

  roer.stage.registerTab({
    id: "changes",
    title: "Changes",
    component: Changes,
    order: 20,
    // It follows a `cd` and a session switch itself, and keeps the file that
    // was selected while the terminal is on top.
    keepAcrossSessions: true,
    copy: { prepare: prepareCopy },
  });
  // An agent's review lands in the tab; the strip says so until the tab is opened and counts for itself.
  roer.tools.register(addCommentsTool((pending) => roer.badge.set("changes", pending > 0 ? String(pending) : null)));
});
