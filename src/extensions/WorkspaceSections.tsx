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
}

/**
 * The extensions' own sections of the Workspace tab, after its Projects: a
 * dashboard of what the Workspace's repositories are up to, say. Each one
 * starts over for another Workspace or Project, as a tab does for another
 * session, so what one showed never stands for another.
 */
export function WorkspaceSections({ scope, session, active, openFile, activateTab }: WorkspaceSectionsProps) {
  const sections = useWorkspaceSections();
  return (
    <>
      {sections.map((entry) => {
        const View = entry.component;
        return (
          <section key={`${entry.extension}/${entry.id}`} className="workspace-section" aria-label={entry.title}>
            <h2 className="muted">{entry.title}</h2>
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
    </>
  );
}
