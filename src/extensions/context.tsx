/**
 * What a tab's component reads through the `roer` hooks: the session on the
 * stage, whether its tab is on top, and the stage's own actions. Components
 * take no props, so an extension's tab and a bundled one are mounted alike.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { FilesChanged } from "../lib/files";
import { gitCurrentBranch, gitRoot } from "../lib/git";
import { sendToSession } from "../lib/github";
import { resolveDir } from "../lib/session";
import type { Session } from "./api";

interface Host {
  session: Session | null;
  active: boolean;
  openFile: (root: string, path: string, line?: number) => void;
  activateTab: (tabId: string) => void;
}

const HostContext = createContext<Host>({
  session: null,
  active: false,
  openFile: () => undefined,
  activateTab: () => undefined,
});

export function HostProvider({ value, children }: { value: Host; children: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

/** The session on the stage; null while there is none. */
export const useSession = (): Session | null => useContext(HostContext).session;

/** Whether this tab is the one on top. */
export const useActive = (): boolean => useContext(HostContext).active;

/** Opens a file of the repository at `root` in a tab of its own. */
export const useOpenFile = (): Host["openFile"] => useContext(HostContext).openFile;

/** Brings a tab to the top, by its id ("terminal", "changes", …). */
export const useActivateTab = (): Host["activateTab"] => useContext(HostContext).activateTab;

/**
 * The stage's session as tabs see it, with its repository and branch looked
 * up. Looked up again when the session or its watch moves; a `cd` that
 * leaves the repository shows on the next change the watch reports.
 */
export function useStageSession(
  staged: { cwd?: string; pane?: string } | null,
  info: { agent?: string; busy: boolean; changed: FilesChanged | null },
): Session | null {
  const [where, setWhere] = useState<{ root: string | null; branch: string | null }>({ root: null, branch: null });
  const cwd = staged?.cwd;
  const pane = staged?.pane;
  const changedRoot = info.changed?.root;
  const has = staged !== null;

  useEffect(() => {
    if (!has) {
      setWhere({ root: null, branch: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const dir = await resolveDir(cwd, pane);
      const root = await gitRoot(dir).catch(() => null);
      const branch = root ? await gitCurrentBranch(root).catch(() => null) : null;
      if (!cancelled) setWhere({ root, branch });
    })();
    return () => {
      cancelled = true;
    };
  }, [has, cwd, pane, changedRoot]);

  return useMemo(
    () =>
      staged
        ? {
            pane,
            cwd,
            root: where.root,
            branch: where.branch,
            agent: info.agent,
            busy: info.busy,
            changed: info.changed,
            send: (text: string) => (pane ? sendToSession(pane, text) : Promise.reject(new Error("no pane yet"))),
          }
        : null,
    [staged, pane, cwd, where, info.agent, info.busy, info.changed],
  );
}
