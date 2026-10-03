import { useCallback } from "react";
import { defineExtension, useActivateTab, useActive, useSession } from "roer";

import { ReviewView } from "./ReviewView";
import { addCommentsTool } from "./tool";

/** The Review tab: the branch's pull request and its review comments, or its local changes and your own comments on
 * them, and what to do about each. */
export default defineExtension((roer) => {
  function Review() {
    const session = useSession();
    const active = useActive();
    const activateTab = useActivateTab();
    // The strip shows how many comments still wait on a decision.
    const onOpenCount = useCallback((count: number) => roer.badge.set("review", count > 0 ? String(count) : null), []);
    return (
      <ReviewView
        session={session}
        active={active}
        onSent={() => activateTab("terminal")}
        onOpenPullRequest={() => activateTab("pullRequest")}
        onOpenCount={onOpenCount}
      />
    );
  }

  roer.stage.registerTab({ id: "review", title: "Review", component: Review, order: 25 });
  // An agent's review lands in the tab; the strip says so until the tab is opened and counts for itself.
  roer.tools.register(addCommentsTool((pending) => roer.badge.set("review", pending > 0 ? String(pending) : null)));
});
