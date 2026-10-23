import { useState } from "react";

import type { Scope, Session } from "./api";
import { HostProvider } from "./context";
import { useWorkspaceSections } from "./registry";
import { Catch } from "./TabBody";

export interface WorkspaceSectionsProps {
  scope: Scope;
  session: Session | null;
  /** The Workspace tab is on top. */
  active: boolean;
  openFile: (root: string, path: string, line?: number) => void;
  activateTab: (tabId: string) => void;
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

/**
 * The extensions' own sections of the Workspace tab, after its Projects: a
 * dashboard of what the Workspace's repositories are up to, say. Each one
 * starts over for another Workspace or Project, as a tab does for another
 * session, so what one showed never stands for another. One the person has
 * no use for in a Workspace or Project is hidden there, and only there.
 */
export function WorkspaceSections({ scope, session, active, openFile, activateTab, onAddSection }: WorkspaceSectionsProps) {
  const sections = useWorkspaceSections();
  const { hidden, hide, showAll } = useHidden(scope);
  const here = scope.kind === "workspace" ? "this workspace" : "this project";
  const shown = sections.filter((entry) => !hidden.has(`${entry.extension}/${entry.id}`));
  const hiddenCount = sections.length - shown.length;
  return (
    <>
      {shown.map((entry) => {
        const View = entry.component;
        const key = `${entry.extension}/${entry.id}`;
        return (
          <section key={key} className="workspace-section" aria-label={entry.title}>
            <h2 className="muted">
              {entry.title}
              <button
                type="button"
                className="link"
                aria-label={`Hide ${entry.title} in ${here}`}
                title={`Hide in ${here}; other workspaces and projects keep it`}
                onClick={() => hide(key)}
              >
                Hide
              </button>
            </h2>
            {/* Keys stay with the terminal and the tab strip: a section is
              shown beside them, not given the keyboard. */}
            <HostProvider value={{ extension: entry.extension, session, scope, active, focused: false, openFile, activateTab }}>
              <Catch key={`${entry.generation}:${scope.kind}:${scope.id}`} extension={entry.extension}>
                <View />
              </Catch>
            </HostProvider>
          </section>
        );
      })}
      <p className="muted workspace-sections-more">
        {hiddenCount > 0 ? (
          <>
            {hiddenCount === 1 ? "1 section is" : `${hiddenCount} sections are`} hidden in {here}.{" "}
            <button type="button" className="link" onClick={showAll}>
              Show {hiddenCount === 1 ? "it" : "them"}
            </button>
            {onAddSection ? " · " : null}
          </>
        ) : null}
        {onAddSection ? (
          <button type="button" className="link" onClick={onAddSection}>
            Add a section…
          </button>
        ) : null}
      </p>
    </>
  );
}
