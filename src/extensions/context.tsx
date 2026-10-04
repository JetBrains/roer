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
  /** The extension whose tab this is. */
  extension: string;
  session: Session | null;
  active: boolean;
  openFile: (root: string, path: string, line?: number) => void;
  activateTab: (tabId: string) => void;
}

const HostContext = createContext<Host>({
  extension: "",
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

/** The id of the extension whose tab is rendering. */
export const useExtensionId = (): string => useContext(HostContext).extension;

/**
 * The stage's session as tabs see it, with its repository and branch looked
 * up. Looked up again when the session moves and on every batch its watch
 * reports, so a `git checkout` or a `cd` in the terminal shows on the next
 * change. What was found is kept with the session it was found for, so a
 * tab never sees one session's pane with another's repository.
 */
export function useStageSession(
  staged: { cwd?: string; pane?: string } | null,
  info: { agent?: string | null; busy: boolean; changed: FilesChanged | null },
): Session | null {
  const cwd = staged?.cwd;
  const pane = staged?.pane;
  const key = `${cwd ?? ""}\0${pane ?? ""}`;
  const [found, setFound] = useState<{ key: string; root: string | null; branch: string | null } | null>(null);
  const changed = info.changed;
  const has = staged !== null;

  useEffect(() => {
    if (!has) return;
    let cancelled = false;
    void (async () => {
      const dir = await resolveDir(cwd, pane);
      const root = await gitRoot(dir).catch(() => null);
      const branch = root ? await gitCurrentBranch(root).catch(() => null) : null;
      if (cancelled) return;
      // The same answer keeps the same object, so a batch that moved nothing re-renders nothing.
      setFound((last) => (last?.key === key && last.root === root && last.branch === branch ? last : { key, root, branch }));
    })();
    return () => {
      cancelled = true;
    };
  }, [has, cwd, pane, key, changed]);

  const where = found?.key === key ? found : null;
  const root = where?.root ?? null;
  const branch = where?.branch ?? null;

  return useMemo(
    () =>
      staged
        ? {
            pane,
            cwd,
            root,
            branch,
            agent: info.agent,
            busy: info.busy,
            changed: info.changed,
            send: (text: string) =>
              !pane
                ? Promise.reject(new Error("no pane yet"))
                : info.agent === null
                  ? Promise.reject(new Error("only a shell is running in this session: start an agent in it first"))
                  : sendToSession(pane, text),
          }
        : null,
    [staged, pane, cwd, root, branch, info.agent, info.busy, info.changed],
  );
}
