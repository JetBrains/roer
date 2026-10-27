import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { Scope, Session } from "./api";
import { HostProvider, type AgentSession, type StartSession } from "./context";
import { useWorkspaceSections } from "./registry";
import { Catch } from "./TabBody";

export interface WorkspaceSectionsProps {
  scope: Scope;
  session: Session | null;
  /** The Workspace tab is on top. */
  active: boolean;
  openFile: (root: string, path: string, line?: number) => void;
  activateTab: (tabId: string) => void;
  startSession?: StartSession;
  sessions?: readonly AgentSession[];
  showSession?: (pane: string) => void;
  /** Asks the session's agent for a section of the person's own. */
  onAddSection?: () => void;
}

/** Which sections are hidden where: by `kind:id` of the scope, each section
 * by `extension/id`. Kept here rather than on the Workspace, since which
 * dashboards one wants to look at is the viewer's own business. */
const HIDDEN_KEY = "roer:hidden-sections";

function readHidden(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function useHidden(scope: Scope) {
  const where = `${scope.kind}:${scope.id}`;
  const [all, setAll] = useState(readHidden);
  const hidden = new Set(all[where] ?? []);
  const set = (next: Set<string>) => {
    const updated = { ...all, [where]: [...next] };
    if (next.size === 0) delete updated[where];
    setAll(updated);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(updated));
    } catch {
      /* only a convenience */
    }
  };
  return {
    hidden,
    hide: (key: string) => set(new Set([...hidden, key])),
    showAll: () => set(new Set()),
  };
}

/** Whether the dock is folded to its bar, remembered as the list's groups are. */
const FOLDED_KEY = "roer:sections-folded";

function useFoldedDock() {
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setFolded(!folded);
    try {
      localStorage.setItem(FOLDED_KEY, folded ? "0" : "1");
    } catch {
      /* only a convenience */
    }
  };
  return [folded, toggle] as const;
}

/**
 * The extensions' own sections of the Workspace tab: a dashboard of what the
 * Workspace's repositories are up to, say. Docked under the list of sessions
 * rather than after it, so they stay in sight however long that list is,
 * side by side as cards; folded, the dock is one line. Each one starts over
 * for another Workspace or Project, as a tab does for another session, so
 * what one showed never stands for another. One the person has no use for
 * in a Workspace or Project is hidden there, and only there.
 */
export function WorkspaceSections({ scope, session, active, openFile, activateTab, startSession, sessions, showSession, onAddSection }: WorkspaceSectionsProps) {
  const sections = useWorkspaceSections();
  const { hidden, hide, showAll } = useHidden(scope);
  const here = scope.kind === "workspace" ? "this workspace" : "this project";
  const shown = sections.filter((entry) => !hidden.has(`${entry.extension}/${entry.id}`));
  const hiddenCount = sections.length - shown.length;
  const [folded, toggleFolded] = useFoldedDock();
  return (
    <section className={folded ? "workspace-dock folded" : "workspace-dock"} aria-label="Sections">
      <div className="workspace-dock-head">
        <button type="button" className="fold" aria-expanded={!folded} onClick={toggleFolded}>
          {folded ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          Sections
          {shown.length > 0 ? <span className="workspace-dock-count">{shown.length}</span> : null}
        </button>
        <span className="workspace-dock-actions muted">
          {hiddenCount > 0 ? (
            <>
              {hiddenCount === 1 ? "1 hidden" : `${hiddenCount} hidden`} in {here}{" "}
              <button type="button" className="link" onClick={showAll}>
                Show {hiddenCount === 1 ? "it" : "them"}
              </button>
            </>
          ) : null}
          {onAddSection ? (
            <button type="button" className="link" onClick={onAddSection}>
              Add a section…
            </button>
          ) : null}
        </span>
      </div>
      {folded ? null : shown.length === 0 ? (
        <p className="muted workspace-dock-empty">
          {hiddenCount > 0
            ? `Every section is hidden in ${here}.`
            : "No sections yet: an extension adds one, about every project of the workspace at once."}
        </p>
      ) : (
        <div className="workspace-dock-body">
          {shown.map((entry) => {
            const View = entry.component;
            const key = `${entry.extension}/${entry.id}`;
            return (
              <section key={key} className="workspace-card" aria-label={entry.title}>
                <header>
                  <h3>{entry.title}</h3>
                  <button
                    type="button"
                    className="link"
                    aria-label={`Hide ${entry.title} in ${here}`}
                    title={`Hide in ${here}; other workspaces and projects keep it`}
                    onClick={() => hide(key)}
                  >
                    Hide
                  </button>
                </header>
                <div className="workspace-card-body">
                  {/* Keys stay with the terminal and the tab strip: a section
                    is shown beside them, not given the keyboard. */}
                  <HostProvider value={{ extension: entry.extension, session, scope, active, focused: false, openFile, activateTab, startSession, sessions, showSession }}>
                    <Catch key={`${entry.generation}:${scope.kind}:${scope.id}`} extension={entry.extension}>
                      <View />
                    </Catch>
                  </HostProvider>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
