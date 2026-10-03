import { Component, type ErrorInfo, type ReactNode } from "react";

import type { Session } from "./api";
import { HostProvider } from "./context";
import { logExtension } from "./loader";
import type { StageTabEntry } from "./registry";

interface CatchProps {
  extension: string;
  children: ReactNode;
}

/**
 * One tab's render failing stays in that tab: the card says what went wrong,
 * the extension's log gets the stack, and the rest of the app goes on.
 */
class Catch extends Component<CatchProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void logExtension(this.props.extension, `render failed: ${error.stack ?? error.message}${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty">
        <p className="error">
          {this.props.extension} failed: {error.message}
        </p>
        <p className="muted">
          <code>roer ext logs {this.props.extension}</code> has the details.
        </p>
      </div>
    );
  }
}

export interface TabBodyProps {
  entry: StageTabEntry;
  session: Session | null;
  active: boolean;
  openFile: (root: string, path: string, line?: number) => void;
  activateTab: (tabId: string) => void;
}

/** An extension's tab, with the session and stage its hooks read. */
export function TabBody({ entry, session, active, openFile, activateTab }: TabBodyProps) {
  const View = entry.component;
  // Another session is another tab, unless the tab asked to keep its state.
  const key = entry.keepAcrossSessions ? "kept" : (session?.pane ?? "none");
  return (
    <HostProvider value={{ extension: entry.extension, session, active, openFile, activateTab }}>
      {/* A new component (a reload) starts the boundary over, and so does another session. */}
      <Catch key={`${entry.generation}:${key}`} extension={entry.extension}>
        <View />
      </Catch>
    </HostProvider>
  );
}
