import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DiffBrowserView } from "./DiffBrowserView";
import { FileView } from "./FileView";
import { GenerativeUITab } from "./generative-ui/GenerativeUITab";
import { applyAll, applyMessage } from "./generative-ui/apply";
import { emptyState, type A2uiMessage, type RenderState } from "./generative-ui/schema";
import { GoToFile } from "./GoToFile";
import { NewSessionButton } from "./NewSessionButton";
import { SessionBrowser, type OpenRequest } from "./SessionBrowser";
import { TerminalView } from "./TerminalView";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { onFilesChanged, type FilesChanged } from "./lib/files";
import { isGoToFile, isNewSession, useHotkey } from "./lib/keys";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import {
  activate,
  closeTab,
  forRoot,
  noTabs,
  openFile,
  recent,
  tabId,
  tabName,
  type Tabs,
} from "./lib/tabs";
import {
  ackHandoff,
  claimHandoff,
  failHandoff,
  listSessions,
  onHandoff,
  pendingHandoffs,
  type Handoff,
  type SessionInfo,
} from "./lib/pty";
import { onPluginUi } from "./lib/pluginUi";

interface SessionView extends OpenRequest {
  /** Set when this session was teleported in; a terminal is waiting on it.
   * Holds the *claimed* record path, which is what ack and fail take. */
  record?: string;
}

/**
 * Identity of what is on the stage: a different target is a different
 * terminal, so it keys the view and marks the session list stale. The nonce is
 * what makes two new sessions in the same directory two sessions.
 */
function targetOf(session: SessionView | null): string {
  return session
    ? `${session.nonce ?? ""}:${session.args.join(" ")}:${session.cwd ?? ""}`
    : "none";
}

function viewOf(handoff: Handoff, record: string): SessionView {
  return {
    args: handoff.args,
    cwd: handoff.cwd,
    title: handoff.label,
    // The shim hands over a pane for an attach; a resume has no pane yet.
    pane: handoff.args[0] === "attach" ? handoff.args[1] : undefined,
    record,
  };
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tabs>(noTabs);
  const [finding, setFinding] = useState(false);
  // The changes view stays mounted once opened, so switching back to the
  // terminal and away again keeps the file that was selected. File tabs get
  // this for free: being open is being in `tabs.files`.
  const [everChanges, setEverChanges] = useState(false);
  // Same reasoning as `everChanges`: mount once, keep it mounted, so
  // collapsing the panel and reopening it does not lose a live surface.
  const [everGenerativeUI, setEverGenerativeUI] = useState(false);
  // The Generative UI panel's state: empty (a placeholder message) until a
  // real message arrives from `roer plugin-ui`.
  const [generativeUi, setGenerativeUi] = useState<{
    state: RenderState;
    surfaceId: string;
    log: readonly A2uiMessage[];
    live: boolean;
  }>(() => ({
    state: emptyState,
    surfaceId: "",
    log: [],
    live: false,
  }));
  // Acking twice would try to delete an already-deleted record.
  const ackedRef = useRef<string | null>(null);
  // Persisted so the sidebar doesn't spring back open on the next launch.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("roer:sidebar-collapsed") === "1",
  );
  useEffect(() => {
    localStorage.setItem(
      "roer:sidebar-collapsed",
      sidebarCollapsed ? "1" : "0",
    );
  }, [sidebarCollapsed]);
  // Unlike `sidebarCollapsed`, this is never persisted: the panel is a side
  // column now, not a tab, so it should only ever claim space when there is
  // something to show, freshly each launch — a live message expands it
  // itself (see the `onPluginUi` listener), not a memory of last time.
  const [generativePanelCollapsed, setGenerativePanelCollapsed] = useState(true);

  const target = targetOf(session);

  // What is on the stage, read synchronously. The handoff listener is
  // registered once and cannot close over a render's values, and a handoff
  // arriving in the same tick as another must see the first one.
  const stagedRef = useRef<SessionView | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  // The target that has proved itself live. A terminal only proves it by
  // producing output, which happens once per mount.
  const attachedRef = useRef<string | null>(null);
  // Handoffs claimed while the stage still owes a terminal its proof. The
  // stage holds one session, so showing them at once would evict a session
  // whose terminal is still waiting to hear that it moved.
  const queueRef = useRef<SessionView[]>([]);
  // This session's pane, for scoping incoming plugin-ui messages to it.
  const paneRef = useRef<string | undefined>(undefined);

  // Go to File asks about the session's repository, so there is nothing to
  // search without one. Read through the ref, so the handler stays the same
  // function across renders and the listener is registered once.
  useHotkey(
    isGoToFile,
    useCallback(() => {
      if (stagedRef.current) setFinding(true);
    }, []),
  );

  // A different target is a different terminal, and it has not attached yet.
  useEffect(() => {
    if (attachedRef.current !== target) attachedRef.current = null;
  }, [target]);

  const show = useCallback((next: SessionView) => {
    stagedRef.current = next;
    setNotice(null);
    setSession(next);
    // Opening a session is what the list was for; showing it is the point,
    // not another thing to switch to once it's found.
    setTabs((current) => activate(current, "terminal"));
  }, []);

  /** Shows the next queued handoff, if the stage has come free. */
  const drain = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return false;
    show(next);
    return true;
  }, [show]);

  const ack = useCallback(
    (record: string | undefined) => {
      if (!record || ackedRef.current === record) return;
      ackedRef.current = record;
      // Releases the waiting terminal, now that the session is really rendering.
      void ackHandoff(record)
        .catch(() => {
          /* The terminal has its own timeout to fall back on. */
        })
        // Nobody is owed proof any more, so a handoff that arrived meanwhile
        // can have the stage.
        .finally(() => drain());
    },
    [drain],
  );

  /** True while the staged session owes a terminal its proof. */
  const owesProof = useCallback(() => {
    const record = stagedRef.current?.record;
    return Boolean(record) && ackedRef.current !== record;
  }, []);

  const accept = useCallback(
    async (handoff: Handoff) => {
      // Claim before attaching: the shim cancels by renaming this same path,
      // so a failure here means it gave up and still holds the session.
      let claimed: string;
      try {
        claimed = await claimHandoff(handoff.record);
      } catch {
        return;
      }
      const next = viewOf(handoff, claimed);
      if (owesProof()) {
        queueRef.current.push(next);
        return;
      }
      // `roer` in a terminal for the session Roer is already showing. The
      // target does not change, so nothing remounts and no further output
      // will arrive to prove the attach — it is already proved. Without this
      // the waiting terminal blocks for its whole timeout and then reports
      // that nothing moved, even though the session is on screen.
      if (
        targetOf(next) === targetRef.current &&
        attachedRef.current === targetRef.current
      ) {
        show(next);
        ack(claimed);
        return;
      }
      show(next);
    },
    [ack, owesProof, show],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onHandoff((handoff) => {
      void accept(handoff);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        // Only now, with a listener in place, is it safe to ask for what
        // arrived earlier — the shim starts Roer and then waits, so the
        // handoff that opened the app is nearly always in here.
        return pendingHandoffs().then(async (records) => {
          for (const record of records) {
            if (cancelled) return;
            await accept(record);
          }
        });
      })
      .catch(() => {
        /* Nothing was waiting, or the backend is not up; the watcher covers
           anything that arrives from here on. */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [accept]);

  // One listener for every watched worktree, fanned out to the views by the
  // views themselves: only they know which repository and which file they
  // are showing. Held as the event object, so each batch is a new identity
  // and a view can tell the one it has already acted on.
  const [changed, setChanged] = useState<FilesChanged | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onFilesChanged(setChanged)
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        /* No watcher for this session; the views go back to refreshing when
           they are looked at, which is what they did before. */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Read through a ref for the same reason as `targetRef`: the listener is
  // registered once and cannot close over a render's `session`.
  paneRef.current = session?.pane;
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onPluginUi((record) => {
      // Scoped to this session's pane: a message tagged for a pane nobody is
      // looking at would otherwise pop the panel open and overwrite whatever
      // is on screen for the session that *is*.
      if (!paneRef.current || record.pane !== paneRef.current) return;

      setGenerativeUi((current) => ({
        // The fixture and a live surface are dropped together, not merged —
        // the first real message starts the reducer over.
        state: applyMessage(current.live ? current.state : emptyState, record.message),
        surfaceId: record.message.surfaceId,
        log: current.live ? [...current.log, record.message] : [record.message],
        live: true,
      }));
      setEverGenerativeUI(true);
      setGenerativePanelCollapsed(false);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        /* No watcher available; the tab stays on its fixture. */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // A session released or ended leaves no repository to be looking at, so
  // every file tab is about a directory nobody is in any more. With nothing
  // to show on the stage, the session list is the useful thing to be
  // looking at, so it's what comes up rather than an empty terminal.
  const staged = Boolean(session);
  useEffect(() => {
    if (!staged) {
      setTabs((current) => activate(forRoot(current, undefined), "sessions"));
      setFinding(false);
    }
  }, [staged]);

  /** Opens a file from Go to File, in a tab of its own. */
  const openInTab = useCallback((root: string, path: string, line?: number) => {
    setTabs((current) =>
      // A file from another repository means the session has moved, and the
      // tabs from where it was are about nothing now.
      openFile(forRoot(current, root), { kind: "file", root, path, line }),
    );
  }, []);

  /**
   * Learns the pane tmux made for a session started from the launcher.
   *
   * `roer new` names and creates the session itself, so there is nothing to
   * look it up by until it exists. The pane is what says which session is on
   * screen — which row of the session browser is the live one, and which
   * directory the changes view is about, after a `cd` has moved it.
   */
  const adopt = useCallback(async () => {
    const staged = stagedRef.current;
    const known = staged?.known;
    if (!staged || staged.pane || !known) return;

    let fresh: SessionInfo[];
    try {
      fresh = (await listSessions()).filter(
        (s) => s.attached && !known.includes(s.pane),
      );
    } catch {
      return;
    }
    // Two sessions appearing at once cannot be told apart, and the wrong pane
    // is worse than none: the view would be about somebody else's session.
    if (fresh.length !== 1 || stagedRef.current !== staged) return;

    const next = { ...staged, pane: fresh[0].pane };
    stagedRef.current = next;
    // The target does not depend on the pane, so nothing remounts.
    setSession((current) => (current === staged ? next : current));
  }, []);

  const handleAttached = useCallback(() => {
    attachedRef.current = targetRef.current;
    ack(stagedRef.current?.record);
    void adopt();
  }, [ack, adopt]);

  /**
   * What became of a session whose PTY just ended. Detaching leaves the
   * session running with no client; a shell that exited takes it with it, and
   * saying it can be taken back then would be a lie.
   */
  const describeExit = useCallback(async (gone: SessionView) => {
    if (!gone.pane) return "Session closed.";
    try {
      const sessions = await listSessions();
      return sessions.some((s) => s.pane === gone.pane)
        ? "Session released. It is still running with no client, so `roer` in a terminal will take it back."
        : "Session ended.";
    } catch {
      return "Session closed.";
    }
  }, []);

  const handleExit = useCallback(() => {
    const gone = stagedRef.current;
    stagedRef.current = null;
    setSession(null);

    // A claimed handoff whose session never made it on screen: hand the record
    // back, so the terminal hears that nothing moved instead of waiting out
    // its timeout.
    if (gone?.record && ackedRef.current !== gone.record) {
      void failHandoff(gone.record).catch(() => {
        /* The terminal's timeout says the same thing, more slowly. */
      });
    }

    if (drain()) return;
    if (gone) void describeExit(gone).then(setNotice);
  }, [describeExit, drain]);

  // The Workspace sidebar and the session browser are two places on screen
  // for one piece of state — which Workspace is selected, and what it
  // filters — so one hook call feeds both rather than each keeping its own.
  const browser = useSessionBrowser({
    activePane: session?.pane,
    token: target,
    onOpen: show,
  });

  // Cmd+T for a new session, the same key a browser binds to a new tab. Read
  // through a ref for the same reason as Go to File: the listener is
  // registered once, so it must not close over a stale `openNew`.
  const openNewRef = useRef(browser.openNew);
  openNewRef.current = browser.openNew;
  useHotkey(
    isNewSession,
    useCallback(() => openNewRef.current(), []),
  );

  // Picking a Workspace is asking to see what's in it — if the diff or a
  // file is up instead, that answer is hidden behind a tab nothing else
  // points at.
  const selectWorkspace = useCallback(
    (id: string | null) => {
      browser.setSelectedWorkspaceId(id);
      setTabs((current) => activate(current, "sessions"));
    },
    [browser.setSelectedWorkspaceId],
  );

  // Same reasoning as `selectWorkspace`: picking a Project is asking to see
  // what's running under it.
  const selectProject = useCallback(
    (id: string | null) => {
      browser.setSelectedProjectId(id);
      setTabs((current) => activate(current, "sessions"));
    },
    [browser.setSelectedProjectId],
  );

  return (
    <div className="app-frame">
      {/* macOS draws its native traffic lights over this; a button placed
          inside a drag region stays clickable since only the exact element
          carrying the attribute drags the window. */}
      <div className="titlebar" data-tauri-drag-region="">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-pressed={sidebarCollapsed}
          onClick={() => setSidebarCollapsed((current) => !current)}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={15} />
          ) : (
            <PanelLeftClose size={15} />
          )}
        </button>

        <button
          type="button"
          className="generative-toggle"
          aria-label={
            generativePanelCollapsed ? "Show Generative UI panel" : "Hide Generative UI panel"
          }
          aria-pressed={!generativePanelCollapsed}
          onClick={() => {
            setEverGenerativeUI(true);
            setGenerativePanelCollapsed((current) => !current);
          }}
        >
          {generativePanelCollapsed ? (
            <PanelRightOpen size={15} />
          ) : (
            <PanelRightClose size={15} />
          )}
        </button>
      </div>
      <main className="shell" aria-label="Roer session">
        <WorkspaceSidebar
          collapsed={sidebarCollapsed}
          status={browser.status}
          failure={browser.failure}
          workspaces={browser.workspaces}
          projects={browser.projects}
          selectedWorkspaceId={browser.selectedWorkspaceId}
          setSelectedWorkspaceId={selectWorkspace}
          selectedProjectId={browser.selectedProjectId}
          setSelectedProjectId={selectProject}
          handleCreateWorkspace={browser.handleCreateWorkspace}
          handleRenameWorkspace={browser.handleRenameWorkspace}
          handleDeleteWorkspace={browser.handleDeleteWorkspace}
          handleCreateProject={browser.handleCreateProject}
          handleRenameProject={browser.handleRenameProject}
          handleDeleteProject={browser.handleDeleteProject}
        />

        <section className="stage">
          <div className="tab-bar">
            <div className="tabs" role="tablist" aria-label="Stage">
              <button
                type="button"
                role="tab"
                aria-selected={tabs.active === "sessions"}
                className={tabs.active === "sessions" ? "tab on" : "tab"}
                onClick={() =>
                  setTabs((current) => activate(current, "sessions"))
                }
              >
                Sessions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tabs.active === "terminal"}
                className={tabs.active === "terminal" ? "tab on" : "tab"}
                onClick={() =>
                  setTabs((current) => activate(current, "terminal"))
                }
              >
                Terminal
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tabs.active === "changes"}
                className={tabs.active === "changes" ? "tab on" : "tab"}
                disabled={!session}
                onClick={() => {
                  setEverChanges(true);
                  setTabs((current) => activate(current, "changes"));
                }}
              >
                Changes
              </button>
              {tabs.files.map((file) => {
                const id = tabId(file);
                const name = tabName(file);
                return (
                  // The tab and its close button are two controls, so they are two
                  // buttons; the wrapper is what looks like one tab.
                  <span
                    key={id}
                    className={tabs.active === id ? "tab-wrap on" : "tab-wrap"}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tabs.active === id}
                      className="tab file"
                      title={file.path}
                      onClick={() =>
                        setTabs((current) => activate(current, id))
                      }
                    >
                      {name}
                    </button>
                    <button
                      type="button"
                      className="tab-x"
                      aria-label={`Close ${name}`}
                      onClick={() =>
                        setTabs((current) => closeTab(current, id))
                      }
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>

            <NewSessionButton
              projects={browser.projects}
              openNew={browser.openNew}
              pickingProjectFor={browser.pickingProjectFor}
              cancelProjectPick={browser.cancelProjectPick}
              pickProjectForNewSession={browser.pickProjectForNewSession}
              attachNewProjectForNewSession={
                browser.attachNewProjectForNewSession
              }
            />
          </div>

          <div className="stage-body">
            {session ? (
              <TerminalView
                key={target}
                args={session.args}
                cwd={session.cwd}
                onAttached={handleAttached}
                onExit={handleExit}
              />
            ) : (
              <div className="empty">
                {notice ? <p className="notice">{notice}</p> : null}
                <p className="muted">Pick a session, or start a new one.</p>
              </div>
            )}

            {/* Covers the terminal rather than replacing it, so picking a
              session never has to wait on a teardown, and a session left
              running behind the list keeps its PTY. */}
            <div className="overlay" hidden={tabs.active !== "sessions"}>
              <SessionBrowser
                status={browser.status}
                workspaces={browser.workspaces}
                projects={browser.projects}
                assignments={browser.assignments}
                selectedWorkspace={browser.selectedWorkspace}
                selectedWorkspaceProjects={browser.selectedWorkspaceProjects}
                handleAssign={browser.handleAssign}
                handleAttachExistingProject={
                  browser.handleAttachExistingProject
                }
                handleAttachNewProject={browser.handleAttachNewProject}
                handleDetachProject={browser.handleDetachProject}
                addingItem={browser.addingItem}
                setAddingItem={browser.setAddingItem}
                itemTitle={browser.itemTitle}
                setItemTitle={browser.setItemTitle}
                handleAddItem={browser.handleAddItem}
                handleRemoveItem={browser.handleRemoveItem}
                roots={browser.roots}
                visibleSessions={browser.visibleSessions}
                visibleClaudeSessions={browser.visibleClaudeSessions}
                activePane={browser.activePane}
                openClaudeSession={browser.openClaudeSession}
                refresh={browser.refresh}
                onOpen={show}
              />
            </div>

            {/* An overlay rather than a swap: unmounting the terminal would
              close its PTY, which releases the session to whoever asks for it
              next. The terminal keeps its size too, so nothing reflows when
              the diff is on top of it. */}
            {everChanges ? (
              <div className="overlay" hidden={tabs.active !== "changes"}>
                <DiffBrowserView
                  cwd={session?.cwd}
                  pane={session?.pane}
                  active={tabs.active === "changes"}
                  changed={changed}
                />
              </div>
            ) : null}

            {/* Open is mounted, for the same reason: a file tab keeps its scroll
              position while you are away in the terminal. */}
            {tabs.files.map((file) => {
              const id = tabId(file);
              return (
                <div key={id} className="overlay" hidden={tabs.active !== id}>
                  <FileView
                    root={file.root}
                    path={file.path}
                    line={file.line}
                    active={tabs.active === id}
                    changed={changed}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* A split-view column, not a tab: an A2UI-shaped surface stays
          visible beside whatever the stage is showing, since an agent may
          update it while you are looking at the terminal. Collapsed rather
          than unmounted, same reasoning as the left sidebar. The built-in
          fixture shows until an agent in this session's terminal pipes a
          real one to `roer plugin-ui` — see src/generative-ui/ and
          .claude/skills/generative-ui/. */}
        {everGenerativeUI ? (
          <aside
            className={
              generativePanelCollapsed ? "generative-panel collapsed" : "generative-panel"
            }
          >
            <GenerativeUITab
              state={generativeUi.state}
              surfaceId={generativeUi.surfaceId}
              onChange={(state) => setGenerativeUi((current) => ({ ...current, state }))}
              log={generativeUi.log}
              live={generativeUi.live}
              pane={session?.pane}
              cwd={session?.cwd}
              onLoadBundle={(surfaceId, messages) =>
                setGenerativeUi({ state: applyAll(messages), surfaceId, log: messages, live: true })
              }
            />
          </aside>
        ) : null}

        {finding ? (
          <GoToFile
            cwd={session?.cwd}
            pane={session?.pane}
            recent={recent(tabs)}
            onOpen={openInTab}
            onClose={() => setFinding(false)}
          />
        ) : null}
      </main>
    </div>
  );
}
