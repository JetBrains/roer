/**
 * One tab of the stage as a browser page of its own, which the tab menu's
 * "Open in Browser" lands on (`/?tab=<strip id>`). There is no stage here:
 * a file the tab opens shows beside it, in this page, and everything else it
 * asks of the stage (another tab, a session, a new session) happens in the
 * Roer window, which comes forward to do it while a toast here says so.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { FileView } from "./FileView";
import { TabBody } from "./extensions/TabBody";
import { useExternalExtensions } from "./extensions/loader";
import { useStageTabs } from "./extensions/registry";
import { reachServer, type Reach } from "./lib/backend";
import { sendStageAction, type StageAction } from "./lib/browserServer";
import { baseName } from "./lib/files";

/** The strip id a page was opened for, or null for the whole app. */
export function tabOfPage(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get("tab") || null;
}

/** How long a tab may take to load before the page says it may not be coming. */
const MISSING_AFTER_MS = 5000;
/** How often a page that lost its server asks again. */
const RETRY_MS = 3000;
const TOAST_MS = 3000;

interface OpenFile {
  root: string;
  path: string;
  line?: number;
}

export function TabPage({ tabId }: { tabId: string }) {
  useExternalExtensions();
  const entry = useStageTabs().find((tab) => tab.tabId === tabId);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reach, setReach] = useState<Reach>("up");
  const [late, setLate] = useState(false);

  useEffect(() => {
    document.title = entry ? `${entry.title} — Roer` : "Roer";
  }, [entry]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), MISSING_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Asked again on a timer while it is lost, and whenever the page is looked at again.
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void reachServer().then((now) => {
        if (!cancelled) setReach(now);
      });
    const timer = window.setInterval(check, RETRY_MS);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);

  const toastTimer = useRef<number | undefined>(undefined);
  const say = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /** Hands `action` to the Roer window, saying `done` here once it has it. */
  const inRoer = useCallback(
    async (action: StageAction, done: string): Promise<boolean> => {
      try {
        await sendStageAction(action);
        say(done);
        return true;
      } catch (cause) {
        say(`Roer could not do that: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      }
    },
    [say],
  );

  const openFile = useCallback((root: string, path: string, line?: number) => setFile({ root, path, line }), []);
  const activateTab = useCallback(
    (id: string) => void inRoer({ kind: "activateTab", tabId: id }, "Shown in Roer"),
    [inRoer],
  );
  const showSession = useCallback(
    (pane: string) => void inRoer({ kind: "showSession", pane }, "Shown in Roer"),
    [inRoer],
  );
  const startSession = useCallback(
    (cwd: string, prompt: string, options?: { pickAgent?: boolean }) =>
      inRoer({ kind: "startSession", cwd, prompt, pickAgent: options?.pickAgent }, "Started in Roer"),
    [inRoer],
  );

  return (
    <div className="tab-page">
      {reach !== "up" ? (
        <div className="tab-page-lost" role="status">
          {reach === "down"
            ? "Roer can't be reached. Is it still running? Trying again…"
            : "Roer was started again since this page was opened. Open the tab in the browser from Roer again."}
        </div>
      ) : null}
      <div className="tab-page-body">
        <div className="tab-page-main ext-tab">
          {!entry ? (
            <div className="empty">
              <p className="muted">{late ? `There is no tab ${tabId} in Roer right now.` : "Loading…"}</p>
            </div>
          ) : entry.needsSession ? (
            <div className="empty">
              <p className="muted">{entry.title} needs a session, and a browser page has none. Open it in Roer.</p>
            </div>
          ) : (
            <TabBody
              entry={entry}
              session={null}
              active
              openFile={openFile}
              activateTab={activateTab}
              startSession={startSession}
              showSession={showSession}
            />
          )}
        </div>
        {file ? (
          <div className="tab-page-side">
            <div className="split-head">
              <span className="split-title" title={file.path}>
                {baseName(file.path)}
              </span>
              <button
                type="button"
                className="split-tool"
                title="Close"
                aria-label="Close"
                onClick={() => setFile(null)}
              >
                ×
              </button>
            </div>
            <div className="split-body">
              <FileView root={file.root} path={file.path} line={file.line} active />
            </div>
          </div>
        ) : null}
      </div>
      {toast ? (
        <div className="tab-page-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
