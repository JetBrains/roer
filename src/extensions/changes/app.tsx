import { defineExtension, useActive, useSession } from "roer";

import { DiffBrowserView } from "./DiffBrowserView";

/** The Changes tab: the session's repository, its local edits and the branch's commits. */
function Changes() {
  const session = useSession();
  const active = useActive();
  return <DiffBrowserView cwd={session?.cwd} pane={session?.pane} active={active} changed={session?.changed} />;
}

export default defineExtension((roer) => {
  roer.stage.registerTab({
    id: "changes",
    title: "Changes",
    component: Changes,
    order: 20,
    // It follows a `cd` and a session switch itself, and keeps the file that
    // was selected while the terminal is on top.
    keepAcrossSessions: true,
  });
});
