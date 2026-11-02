/**
 * One tab of the stage as a browser page of its own, which the tab menu's
 * "Open in Browser" lands on (`/?tab=<strip id>`). There is no stage here:
 * a file the tab opens shows beside it, in this page, and everything else it
 * asks of the stage (another tab, a session, a new session) happens in the
 * Roer window, which comes forward to do it while a toast here says so.
 *
 * A tab that needs a session is pinned to the one it was opened from
 * (`&pane=…&id=…&cwd=…`), named in a bar above it, so a page on another
 * screen never quietly shows another repository. "Follow Roer" lets it show
 * whatever the stage shows instead. When its session ends, the page says so
 * and offers the live ones.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { FileView } from "./FileView";
import { runningAgent } from "./SessionBrowser";
import { TabBody } from "./extensions/TabBody";
import { useStageSession, type AgentSession } from "./extensions/context";
import { useExternalExtensions } from "./extensions/loader";
import { useStageTabs } from "./extensions/registry";
import { reachServer, type Reach } from "./lib/backend";
import {
  currentStage,
  onStage,
  onStageActionDone,
  sendStageAction,
  tabPagePath,
  type StageAction,
  type StagedSession,
} from "./lib/browserServer";
import { baseName, onFilesChanged, type FilesChanged } from "./lib/files";
import { listSessions, type SessionInfo } from "./lib/pty";

/** The strip id a page was opened for, or null for the whole app. */
export function tabOfPage(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get("tab") || null;
}

/** The session a page was opened pinned to, if any. */
export function pinnedOfPage(search: string = window.location.search): StagedSession | null {
  const query = new URLSearchParams(search);
  const pane = query.get("pane");
  if (!pane) return null;
  return { pane, id: query.get("id") ?? undefined, cwd: query.get("cwd") ?? undefined };
}

/** How long a tab may take to load before the page says it may not be coming. */
const MISSING_AFTER_MS = 5000;
/** How often a page asks after its server and the live sessions. */
const POLL_MS = 3000;
const TOAST_MS = 3000;
/** Long enough to read a toast that offers something, and click it. */
const OFFER_MS = 10000;
/** A started session the person may still be picking an agent for. */
const START_WAIT_MS = 120000;

interface OpenFile {
  root: string;
  path: string;
  line?: number;
}

interface Toast {
  text: string;
  action?: { label: string; run: () => void };
}

/** The live session `staged` names: same pane, and same session where the id is known. */
const liveOf = (live: readonly SessionInfo[] | null, staged: StagedSession | null): SessionInfo | undefined =>
  staged ? live?.find((one) => one.pane === staged.pane && (!staged.id || one.id === staged.id)) : undefined;

const stagedOf = (live: SessionInfo): StagedSession => ({ pane: live.pane, id: live.id, cwd: live.cwd });

/** A live session's name in a list: its agent, and where it runs. */
const nameOf = (live: SessionInfo): string => {
  const agent = runningAgent(live);
  return `${agent ?? "shell"} · ${baseName(live.cwd.replace(/\/+$/, "")) || live.cwd}${live.title ? ` — ${live.title}` : ""}`;
};

export function TabPage({ tabId, pinned: pinnedAtFirst = null }: { tabId: string; pinned?: StagedSession | null }) {
  useExternalExtensions();
  const entry = useStageTabs().find((tab) => tab.tabId === tabId);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [reach, setReach] = useState<Reach>("up");
  const [late, setLate] = useState(false);
  const [pinned, setPinned] = useState<StagedSession | null>(pinnedAtFirst);
  const [following, setFollowing] = useState(false);
  const [roerStage, setRoerStage] = useState<StagedSession | null>(null);
  const [live, setLive] = useState<SessionInfo[] | null>(null);
  const [changed, setChanged] = useState<FilesChanged | null>(null);

  const wantsSession = Boolean(entry?.needsSession || pinnedAtFirst);
  const staged = following ? roerStage : pinned;
  const stagedLive = liveOf(live, staged);
  // Gone only once the list has been read without it; until then it is just not known yet.
  const ended = staged !== null && live !== null && !stagedLive;
  const session = useStageSession(staged && !ended ? staged : null, {
    agent: stagedLive ? runningAgent(stagedLive) : undefined,
    busy: stagedLive?.state === "working",
    changed,
    liveCwd: stagedLive?.cwd,
  });
  const sessions: AgentSession[] = (live ?? []).flatMap((one) => {
    const agent = runningAgent(one);
    return agent ? [{ pane: one.pane, id: one.id, agent, cwd: one.cwd }] : [];
  });

  useEffect(() => {
    document.title = entry ? `${entry.title} — Roer` : "Roer";
  }, [entry]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), MISSING_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // A reload comes back to the same session.
  useEffect(() => {
    if (!wantsSession) return;
    const path = tabPagePath(tabId, following ? null : pinned);
    if (window.location.pathname + window.location.search !== path) window.history.replaceState(null, "", path);
  }, [wantsSession, tabId, pinned, following]);

  // The server, and the live sessions with it: asked again on a timer, and whenever the page is looked at again.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      void reachServer().then((now) => {
        if (!cancelled) setReach(now);
      });
      if (wantsSession)
        void listSessions().then(
          (now) => {
            if (!cancelled) setLive(now);
          },
          () => undefined,
        );
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [wantsSession]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onFilesChanged(setChanged).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const toastTimer = useRef<number | undefined>(undefined);
  const say = useCallback((next: Toast) => {
    setToast(next);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), next.action ? OFFER_MS : TOAST_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // A session started from here, waited for: its request, and the pane the page was on when it asked.
  const awaiting = useRef<{
    request: string;
    from: string | undefined;
    resolve: (ok: boolean) => void;
    /** The switch to it was offered already. */
    offered?: boolean;
  } | null>(null);
  const followingRef = useRef(following);
  followingRef.current = following;

  // What the stage shows: kept while following, and watched for a session this page started.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onStage((stage) => {
      setRoerStage(stage);
      const waiting = awaiting.current;
      if (waiting && !waiting.offered && stage?.pane && stage.pane !== waiting.from && !followingRef.current) {
        waiting.offered = true;
        say({ text: "Started in Roer", action: { label: "Switch to the new session", run: () => setPinned(stage) } });
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [say]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onStageActionDone((done) => {
      const waiting = awaiting.current;
      if (waiting?.request === done.request) waiting.resolve(done.ok);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const follow = useCallback(() => {
    setFollowing(true);
    void currentStage().then(setRoerStage, () => undefined);
  }, []);
  /** Stops following, staying on what the stage showed. */
  const pinHere = useCallback(() => {
    setPinned(roerStage);
    setFollowing(false);
  }, [roerStage]);

  /** Hands `action` to the Roer window, saying `done` here once it has it. */
  const inRoer = useCallback(
    async (action: StageAction, done: string): Promise<boolean> => {
      try {
        await sendStageAction(action);
        say({ text: done });
        return true;
      } catch (cause) {
        say({ text: `Roer could not do that: ${cause instanceof Error ? cause.message : String(cause)}` });
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
  const stagedPane = staged?.pane;
  const startSession = useCallback(
    async (cwd: string, prompt: string, options?: { pickAgent?: boolean }): Promise<boolean> => {
      const request = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Settled by the window's answer, or given up on.
      const answered = new Promise<boolean>((resolve) => {
        awaiting.current?.resolve(false);
        awaiting.current = { request, from: stagedPane, resolve };
        window.setTimeout(() => resolve(false), START_WAIT_MS);
      });
      try {
        await sendStageAction({ kind: "startSession", cwd, prompt, pickAgent: options?.pickAgent, request });
      } catch (cause) {
        awaiting.current = null;
        say({ text: `Roer could not do that: ${cause instanceof Error ? cause.message : String(cause)}` });
        return false;
      }
      const ok = await answered;
      const waiting = awaiting.current?.request === request ? awaiting.current : null;
      if (!ok) {
        if (waiting) awaiting.current = null;
        say({ text: "Roer did not start a session" });
        return false;
      }
      // The stage may have moved already and offered the switch: that toast stays. If not, the
      // new session's pane is not known yet, and its announcement offers the switch when it is.
      if (!waiting?.offered) say({ text: "Started in Roer" });
      window.setTimeout(() => {
        if (awaiting.current?.request === request) awaiting.current = null;
      }, OFFER_MS);
      return ok;
    },
    [say, stagedPane],
  );

  /** What the bar above a session's tab names: where it is, its branch, its agent. */
  const label = session
    ? [baseName((session.root ?? session.cwd ?? "").replace(/\/+$/, "")), session.branch, session.agent]
        .filter(Boolean)
        .join(" · ")
    : null;

  let body;
  if (!entry) {
    body = (
      <div className="empty">
        <p className="muted">{late ? `There is no tab ${tabId} in Roer right now.` : "Loading…"}</p>
      </div>
    );
  } else if (ended) {
    const others = (live ?? []).filter((one) => runningAgent(one) !== null || !entry.needsSession);
    body = (
      <div className="empty tab-page-ended">
        <p>This session ended.</p>
        {others.length ? (
          <ul>
            {others.map((one) => (
              <li key={one.id}>
                <button type="button" className="link" onClick={() => setPinned(stagedOf(one))}>
                  {nameOf(one)}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {following ? null : (
          <button type="button" onClick={follow}>
            Follow Roer
          </button>
        )}
      </div>
    );
  } else if (entry.needsSession && !staged) {
    body = (
      <div className="empty">
        <p className="muted">
          {following ? "Roer's stage has no session right now." : `${entry.title} needs a session. Open it from a session in Roer.`}
        </p>
      </div>
    );
  } else {
    body = (
      <TabBody
        entry={entry}
        session={session}
        active
        openFile={openFile}
        activateTab={activateTab}
        startSession={startSession}
        sessions={sessions}
        showSession={showSession}
      />
    );
  }

  return (
    <div className="tab-page">
      {reach !== "up" ? (
        <div className="tab-page-lost" role="status">
          {reach === "down"
            ? "Roer can't be reached. Is it still running? Trying again…"
            : "Roer was started again since this page was opened. Open the tab in the browser from Roer again."}
        </div>
      ) : null}
      {wantsSession ? (
        <div className="tab-page-head">
          <span className="tab-page-session" title={session?.root ?? staged?.cwd}>
            {ended ? "Session ended" : (label ?? (staged ? "…" : "No session"))}
          </span>
          <button
            type="button"
            className={following ? "tab-page-follow on" : "tab-page-follow"}
            aria-pressed={following}
            title={following ? "Stay on this session" : "Show whatever session Roer's stage shows"}
            onClick={following ? pinHere : follow}
          >
            Follow Roer
          </button>
        </div>
      ) : null}
      <div className="tab-page-body">
        <div className="tab-page-main ext-tab">{body}</div>
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
              <FileView root={file.root} path={file.path} line={file.line} active changed={changed} />
            </div>
          </div>
        ) : null}
      </div>
      {toast ? (
        <div className="tab-page-toast" role="status">
          {toast.text}
          {toast.action ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                toast.action?.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
