import { useCallback } from "react";
import { adoptLocal, defineExtension, useActivateTab, useActive, useSession } from "roer";

import { ChangesView } from "./ChangesView";
import { REVIEW_PREFIX } from "./local";
import { addCommentsTool } from "./tool";

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
  });
  // An agent's review lands in the tab; the strip says so until the tab is opened and counts for itself.
  roer.tools.register(addCommentsTool((pending) => roer.badge.set("changes", pending > 0 ? String(pending) : null)));
});
