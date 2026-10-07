import { message } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  BellOff,
  Globe,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Puzzle,
  Search,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { loadBundled } from "./extensions/bundled";
import { useStageSession } from "./extensions/context";
import { installHost } from "./extensions/host";
import { useExternalExtensions } from "./extensions/loader";
import { serveTools } from "./extensions/tools";
import { useBadges, useStageTabs } from "./extensions/registry";
import { TabBody } from "./extensions/TabBody";
import { FileView } from "./FileView";
import { GenerativeUITab } from "./generative-ui/GenerativeUITab";
import { applyAll, applyMessage } from "./generative-ui/apply";
import { emptyState, surfaceIdOf, type A2uiMessage, type RenderState } from "./generative-ui/schema";
import { AgentsDialog, type AgentsDialogStart } from "./AgentsDialog";
import { ClaudeSetup } from "./ClaudeSetup";
import { GoToFile, type SessionHit } from "./GoToFile";
import { NewSessionButton } from "./NewSessionButton";
import { NewSessionPicker } from "./NewSessionPicker";
import { SessionTree } from "./SessionTree";
import {
  SessionBrowser,
  isWorking,
  paneLabel,
  relativeAge,
  runningAgent,
  shorten,
  type OpenRequest,
} from "./SessionBrowser";
import { ExtensionsDialog } from "./ExtensionsDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TerminalView } from "./TerminalView";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { claudeSetupStatus, onClaudeSetupMenu, type SetupStatus } from "./lib/claudeSetup";
import { onBrowserServerMenu, startBrowserServer } from "./lib/browserServer";
import { onFilesChanged, type FilesChanged } from "./lib/files";
import { listAgents, onAgentsMenu, type AgentList } from "./lib/agents";
import {
  isGoToFile,
  isMac,
  isManageAgents,
  isNewSession,
  isPickAgent,
  isNewWorktree,
  isNextWaiting,
  isPreviousSession,
  isShortcuts,
  isTabNumber,
  shortcutLabel,
  tabNumber,
  useHotkey,
} from "./lib/keys";
import { useNotificationsOn } from "./lib/notify";
import { nextChoice, useThemeChoice } from "./lib/theme";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import { pickFolder } from "./lib/folderPicker";
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
import { logLine } from "./lib/log";
import { onPluginUi, reportPluginUiReceipt, type PluginUiOutcome } from "./lib/pluginUi";

// Before anything renders: extensions read the host's React and SDK from
// here, and the bundled ones are tabs from the first frame.
installHost();
loadBundled();

/** One tab of the strip, built in or an extension's. */
interface StripTab {
  tabId: string;
  title: string;
  order: number;
  needsSession: boolean;
}

/** The strip's built-in tabs. Extensions' go between and after them by `order`. */
const CORE_TABS: readonly StripTab[] = [
  { tabId: "sessions", title: "Workspace", order: 0, needsSession: false },
  { tabId: "terminal", title: "Terminal", order: 10, needsSession: false },
];

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

/** The menu's "Open This Session in a Browser…", also offered in the title bar. */
function openInBrowser() {
  void startBrowserServer().catch((cause: unknown) => {
    void message(String(cause), {
      title: "Could not start the browser server",
      kind: "error",
    });
  });
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tabs>(noTabs);
  const [finding, setFinding] = useState(false);
  const [showingShortcuts, setShowingShortcuts] = useState(false);
  const [showingExtensions, setShowingExtensions] = useState(false);
  // The agent integrations dialog on screen, if it is: put there by the app on the
  // first launch that finds Claude Code, or asked for from the menu.
  const [setup, setSetup] = useState<{ status: SetupStatus; firstRun: boolean } | null>(null);
  // The agents New session offers, read for the directory it would start in,
  // and the editor when it is open.
  const [agents, setAgents] = useState<AgentList | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentsDialog, setAgentsDialog] = useState<{ start: AgentsDialogStart; startAfterSave: boolean } | null>(null);
  // An extension's tab stays mounted once opened, so switching back to the
  // terminal and away again keeps what it was showing (Changes keeps the
  // file that was selected). File tabs get this for free: being open is
  // being in `tabs.files`.
  const [everOpened, setEverOpened] = useState<ReadonlySet<string>>(() => new Set());
  const opened = useCallback((tabId: string) => {
    setEverOpened((current) => (current.has(tabId) ? current : new Set([...current, tabId])));
  }, []);
  useExternalExtensions();
  // Agents call extensions' tools through this window.
  useEffect(() => serveTools(), []);
  const extensionTabs = useStageTabs();
  const badges = useBadges();
  const strip: StripTab[] = [...CORE_TABS, ...extensionTabs].sort((a, b) => a.order - b.order);
  const stripRef = useRef(strip);
  stripRef.current = strip;
  // Same reasoning as `everOpened`: mount once, keep it mounted, so
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
  const [themeChoice, setThemeChoice] = useThemeChoice();
  const [notificationsOn, setNotificationsOn] = useNotificationsOn();
  // Unlike `sidebarCollapsed`, this is never persisted: the panel is a side
  // column now, not a tab, so it should only ever claim space when there is
  // something to show, freshly each launch — a live message expands it
  // itself (see the `onPluginUi` listener), not a memory of last time.
  const [generativePanelCollapsed, setGenerativePanelCollapsed] = useState(true);
  // The width itself is persisted, unlike the collapsed flag above — a
  // deliberate drag is a preference worth keeping across launches.
  const [generativePanelWidth, setGenerativePanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem("roer:generative-panel-width"));
    return Number.isFinite(stored) && stored > 0 ? stored : 460;
  });
  useEffect(() => {
    localStorage.setItem("roer:generative-panel-width", String(generativePanelWidth));
  }, [generativePanelWidth]);
  // Suppresses the panel's width transition while actively dragging, so the
  // edge tracks the pointer instead of chasing it.
  const [generativePanelResizing, setGenerativePanelResizing] = useState(false);
  const handleGenerativePanelResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = generativePanelWidth;
      setGenerativePanelResizing(true);
      const handleMove = (ev: PointerEvent) => {
        const next = startWidth - (ev.clientX - startX);
        setGenerativePanelWidth(Math.min(900, Math.max(280, next)));
      };
      const handleUp = () => {
        setGenerativePanelResizing(false);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [generativePanelWidth],
  );

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
    useCallback(() => setFinding(true), []),
  );

  // A different target is a different terminal, and it has not attached yet.
  useEffect(() => {
    if (attachedRef.current !== target) attachedRef.current = null;
  }, [target]);

  const show = useCallback((next: SessionView) => {
    logLine(`stage: roer ${next.args.join(" ")}${next.cwd ? ` in ${next.cwd}` : ""}${next.pane ? ` (pane ${next.pane})` : ""}`);
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
    const show = (firstRun: boolean) =>
      claudeSetupStatus()
        .then((status) => {
          if (cancelled || (firstRun && !status.shouldPrompt)) return;
          setSetup({ status, firstRun });
        })
        .catch((cause: unknown) => {
          // Asked for from the menu, a failure is the answer; on launch it
          // just means not asking this time.
          if (!firstRun) {
            void message(String(cause), {
              title: "Could not read agent integrations",
              kind: "error",
            });
          }
        });

    void onClaudeSetupMenu(() => void show(false))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    void show(true);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onBrowserServerMenu(openInBrowser)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
  // The panel's state is global, not keyed by pane, so without this a
  // surface built for pane A stays on screen — and its buttons keep
  // reporting clicks — after the stage moves to pane B. Drop back to the
  // fixture whenever the pane a click would be attributed to changes.
  useEffect(() => {
    setGenerativeUi({ state: emptyState, surfaceId: "", log: [], live: false });
  }, [session?.pane]);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onPluginUi((record) => {
      // Scoped to this session's pane: a message tagged for a pane nobody is
      // looking at would otherwise pop the panel open and overwrite whatever
      // is on screen for the session that *is*. Whatever becomes of it, the
      // sender hears, since nothing on screen says so.
      const onScreen = paneRef.current;
      const outcome: PluginUiOutcome = !onScreen
        ? stagedRef.current
          ? "pane-unknown"
          : "nothing-on-screen"
        : record.pane !== onScreen
          ? "other-pane"
          : "shown";
      if (record.id) void reportPluginUiReceipt(record.id, outcome, onScreen).catch(() => {});
      if (outcome !== "shown") return;

      setGenerativeUi((current) => ({
        // The fixture and a live surface are dropped together, not merged —
        // the first real message starts the reducer over.
        state: applyMessage(current.live ? current.state : emptyState, record.message),
        surfaceId: surfaceIdOf(record.message),
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

  /** Brings a tab up by its id, mounting it if it never was: what an extension's `useActivateTab` does. */
  const activateTab = useCallback(
    (tabId: string) => {
      opened(tabId);
      setTabs((current) => activate(current, tabId));
    },
    [opened],
  );

  /** A tab's Cmd+number, for its tooltip: the first nine in the strip have one. */
  const number = (tabId: string): string | undefined => {
    const at = strip.findIndex((tab) => tab.tabId === tabId);
    return at >= 0 && at < 9 ? shortcutLabel.tab(at + 1) : undefined;
  };

  /** Opens a file from Go to File, in a tab of its own. */
  const openInTab = useCallback((root: string, path: string, line?: number) => {
    // A file from another repository is one of the Workspace's other
    // Projects, so the tabs from this one stay open beside it.
    setTabs((current) => openFile(current, { kind: "file", root, path, line }));
  }, []);

  /**
   * Records the pane tmux made for a session started from the launcher, once,
   * and only for the session it was learned for.
   *
   * `roer new` names and creates the session itself, so there is nothing to
   * look it up by until it exists. The pane is what says which session is on
   * screen — which row of the session browser is the live one, which
   * directory the changes view is about after a `cd` has moved it, and which
   * Generative UI messages are this session's.
   */
  const learnPane = useCallback((staged: SessionView, pane: string) => {
    if (stagedRef.current !== staged || staged.pane) return;
    logLine(`stage: roer ${staged.args.join(" ")} is pane ${pane}`);
    const next = { ...staged, pane };
    stagedRef.current = next;
    // The target does not depend on the pane, so nothing remounts.
    setSession((current) => (current === staged ? next : current));
  }, []);

  /** What the `roer` in this session's terminal said it attached, just
   * before attaching: the answer, where `adopt` can only guess. */
  const handlePane = useCallback(
    (pane: string) => {
      if (stagedRef.current) learnPane(stagedRef.current, pane);
    },
    [learnPane],
  );

  /**
   * The fallback, for a `roer` that says nothing (one from before it did, or
   * a terminal that swallows the OSC): the one attached pane that was not
   * there before. It gives up when that is not exactly one pane.
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
    if (fresh.length !== 1) {
      logLine(`stage: could not tell the new pane, ${fresh.length} candidates`);
      return;
    }
    learnPane(staged, fresh[0].pane);
  }, [learnPane]);

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

  // Cmd+T (Ctrl+Shift+T off macOS) for a new session, the same key a browser binds to a new tab. Read
  // through a ref for the same reason as Go to File: the listener is
  // registered once, so it must not close over a stale `openNew`.
  const openNewRef = useRef(browser.openNew);
  openNewRef.current = browser.openNew;
  const openNewWorktreeRef = useRef(browser.openNewWorktree);
  openNewWorktreeRef.current = browser.openNewWorktree;
  const openPickAgentRef = useRef(() => browser.openPickAgent());
  openPickAgentRef.current = () => browser.openPickAgent();
  useHotkey(
    isNewSession,
    useCallback(() => openNewRef.current(), []),
  );

  // Read again whenever they may have changed: on opening the picker or the
  // editor, and for a different directory, whose project has its own.
  //
  // Only the newest request is kept: a slower answer for the directory before
  // must not replace the list for this one.
  const agentsCwdRef = useRef<string | undefined>(undefined);
  agentsCwdRef.current = browser.newSessionCwd();
  const agentsRequestRef = useRef(0);
  const agentsErrorRef = useRef<string | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const refreshAgents = useCallback(() => {
    const request = ++agentsRequestRef.current;
    return listAgents(agentsCwdRef.current)
      .then((list) => {
        if (request !== agentsRequestRef.current) return undefined;
        agentsErrorRef.current = null;
        setAgentsError(null);
        setAgents(list);
        return list;
      })
      .catch((cause: unknown) => {
        console.warn("could not list agents", cause);
        agentsErrorRef.current = String(cause);
        if (request === agentsRequestRef.current) setAgentsError(String(cause));
        return undefined;
      });
  }, []);
  const agentsCwd = agentsCwdRef.current;
  useEffect(() => {
    // Another directory's project agents are not this one's.
    setAgents(null);
    void refreshAgents();
  }, [agentsCwd, refreshAgents]);

  const openAgentPicker = useCallback(
    (open: boolean) => {
      setAgentPickerOpen(open);
      if (open) void refreshAgents();
    },
    [refreshAgents],
  );
  const openAgents = useCallback(
    (start: AgentsDialogStart, startAfterSave = false) => {
      void refreshAgents().then((list) => {
        if (list) setAgentsDialog({ start, startAfterSave });
        // Asked for, the dialog not opening is an answer only with a reason.
        else if (agentsErrorRef.current) {
          void message(agentsErrorRef.current, { title: "Could not list agents", kind: "error" }).catch(
            () => {},
          );
        }
      });
    },
    [refreshAgents],
  );
  useHotkey(
    isNewWorktree,
    useCallback(() => openNewWorktreeRef.current(), []),
  );
  useHotkey(
    isPickAgent,
    useCallback(() => {
      void refreshAgents();
      openPickAgentRef.current();
    }, [refreshAgents]),
  );
  useHotkey(
    isManageAgents,
    useCallback(() => openAgents({ mode: "edit" }), [openAgents]),
  );
  useHotkey(
    isShortcuts,
    useCallback(() => setShowingShortcuts((open) => !open), []),
  );

  // Cmd+1 to Cmd+9 for the strip's tabs, in its order. A tab that needs a
  // session is out of reach without one, as its button is.
  useHotkey(
    isTabNumber,
    useCallback(
      (event: KeyboardEvent) => {
        const tab = stripRef.current[(tabNumber(event) ?? 0) - 1];
        if (!tab) return;
        if (tab.needsSession && !stagedRef.current) return;
        opened(tab.tabId);
        setTabs((current) => activate(current, tab.tabId));
      },
      [opened],
    ),
  );

  // An extension's tab that went away (removed, or its session folder gone)
  // cannot stay on top, nor can one asked for by an id the strip never had
  // (`useActivateTab` with a typo): either would leave the stage blank.
  const stripIds = strip.map((tab) => tab.tabId).join("\n");
  useEffect(() => {
    const ids = stripIds.split("\n");
    setTabs((current) =>
      current.active.startsWith("file:") || ids.includes(current.active) ? current : activate(current, "terminal"),
    );
  }, [stripIds, tabs.active]);

  // The session on the stage before this one, for Ctrl+Tab: the pane it was
  // in, held while a different one comes up.
  const previousPaneRef = useRef<string | undefined>(undefined);
  const stagedPaneRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (session?.pane && session.pane !== stagedPaneRef.current) {
      previousPaneRef.current = stagedPaneRef.current;
      stagedPaneRef.current = session.pane;
    }
  }, [session?.pane]);

  // Read through refs, like the hotkeys above: registered once, they must
  // see the list as it is now.
  const liveRef = useRef(browser.allSessions);
  liveRef.current = browser.allSessions;
  const waitingNowRef = useRef(browser.waiting);
  waitingNowRef.current = browser.waiting;
  const attach = useCallback(
    (pane: string) => {
      const live = liveRef.current.find((one) => one.pane === pane);
      if (live) show({ args: ["attach", live.pane], cwd: live.cwd, title: live.session, pane: live.pane });
    },
    [show],
  );
  useHotkey(
    isPreviousSession,
    useCallback(() => {
      if (previousPaneRef.current) attach(previousPaneRef.current);
    }, [attach]),
  );
  // In the order tmux lists them, starting after the one on the stage,
  // so pressing again goes on to the next.
  useHotkey(
    isNextWaiting,
    useCallback(() => {
      const panes = liveRef.current.map((one) => one.pane).filter((pane) => waitingNowRef.current.has(pane));
      if (panes.length === 0) return;
      const at = panes.indexOf(stagedPaneRef.current ?? "");
      attach(panes[(at + 1) % panes.length]);
    }, [attach]),
  );

  // What the stage shows, named the way its row in Sessions names it, for
  // the title bar and the window's own title.
  const onStage = browser.visibleSessions.find((live) => live.pane === session?.pane);
  // The session as extensions' tabs see it.
  const stageSession = useStageSession(session, {
    // null for a plain shell, which must never be typed prose into; unknown until the session is listed.
    agent: onStage ? runningAgent(onStage) : undefined,
    busy: onStage?.state === "working",
    changed,
  });
  const stageName = !session
    ? ""
    : onStage
      ? paneLabel(onStage.title, onStage.command) || (runningAgent(onStage) ?? onStage.command)
      : // A teleported session is titled with its pane's title, spinner and all.
        paneLabel(session.title, "");
  useEffect(() => {
    document.title = stageName ? `${stageName} — Roer` : "Roer";
  }, [stageName]);

  // What the search popup offers besides files: every live session, then
  // the past conversations, each opened the way its row in Sessions opens it.
  const home = browser.status?.home;
  const sessionHits: SessionHit[] = [
    ...browser.allSessions.map((live): SessionHit => {
      const who = runningAgent(live) ?? live.command;
      return {
        key: `live:${live.pane}`,
        name: paneLabel(live.title, live.command) || who,
        detail: `${who} · ${shorten(live.cwd, home)}`,
        badge:
          live.pane === session?.pane
            ? "open here"
            : isWorking(live)
              ? "working"
              : browser.waiting.has(live.pane)
                ? live.state === "waiting"
                  ? "needs you"
                  : "waiting"
                : undefined,
        fields: [paneLabel(live.title, live.command), who, live.command, live.session, live.cwd],
        open: () =>
          show({ args: ["attach", live.pane], cwd: live.cwd, title: live.session, pane: live.pane }),
      };
    }),
    ...browser.claudeSessions.map((past): SessionHit => ({
      key: `resume:${past.id}`,
      name: past.title,
      detail: `${past.agent ?? "claude"} · ${shorten(past.cwd, home)}`,
      badge: relativeAge(past.updatedAt),
      fields: [past.title, past.agent ?? "claude", past.cwd],
      open: () => browser.openClaudeSession(past),
    })),
  ];
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onAgentsMenu(() => openAgents({ mode: "edit" }))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openAgents]);


  return (
    <div className="app-frame">
      {/* macOS draws its native traffic lights over this; a button placed
          inside a drag region stays clickable since only the exact element
          carrying the attribute drags the window. Elsewhere the system draws
          its own title bar above it, and nothing needs clearing. */}
      <div className={isMac() ? "titlebar mac" : "titlebar"} data-tauri-drag-region="">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-pressed={sidebarCollapsed}
          onClick={() => setSidebarCollapsed((current) => !current)}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={15} />
          ) : (
            <PanelLeftClose size={15} />
          )}
        </button>

        <span className="titlebar-name" data-tauri-drag-region="" title={session?.cwd}>
          {stageName}
        </span>

        <button
          type="button"
          className="find-toggle"
          aria-label="Search sessions and files"
          title={`Search sessions and files (${shortcutLabel.goToFile()})`}
          onClick={() => setFinding(true)}
        >
          <Search size={15} />
        </button>

        <button
          type="button"
          className="extensions-toggle"
          aria-label="Extensions"
          title="Extensions"
          onClick={() => setShowingExtensions(true)}
        >
          <Puzzle size={15} />
        </button>

        <button
          type="button"
          className="browser-toggle"
          aria-label="Open this session in a browser"
          title="Open this session in a browser"
          onClick={openInBrowser}
        >
          <Globe size={15} />
        </button>

        <button
          type="button"
          className="theme-toggle"
          aria-label={`Theme: ${themeChoice}`}
          title={`Theme: ${themeChoice === "system" ? "match system" : themeChoice}`}
          onClick={() => setThemeChoice(nextChoice(themeChoice))}
        >
          {themeChoice === "system" ? (
            <Monitor size={15} />
          ) : themeChoice === "light" ? (
            <Sun size={15} />
          ) : (
            <Moon size={15} />
          )}
        </button>

        <button
          type="button"
          className="notifications-toggle"
          aria-label="Notifications"
          title={notificationsOn ? "Notifications on" : "Notifications off"}
          aria-pressed={notificationsOn}
          onClick={() => setNotificationsOn(!notificationsOn)}
        >
          {notificationsOn ? <Bell size={15} /> : <BellOff size={15} />}
        </button>

        <button
          type="button"
          className="generative-toggle"
          aria-label={
            generativePanelCollapsed ? "Show Generative UI panel" : "Hide Generative UI panel"
          }
          title={generativePanelCollapsed ? "Show Generative UI panel" : "Hide Generative UI panel"}
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
          setSelectedWorkspaceId={browser.setSelectedWorkspaceId}
          selectedProjectId={browser.selectedProjectId}
          setSelectedProjectId={browser.setSelectedProjectId}
          handleCreateWorkspace={browser.handleCreateWorkspace}
          handleRenameWorkspace={browser.handleRenameWorkspace}
          handleDeleteWorkspace={browser.handleDeleteWorkspace}
          handleAttachExistingProject={browser.handleAttachExistingProject}
          handleAttachNewProject={browser.handleAttachNewProject}
          handleCreateProject={browser.handleCreateProject}
          handleRenameProject={browser.handleRenameProject}
          handleDeleteProject={browser.handleDeleteProject}
        >
          <SessionTree
            status={browser.status}
            workspaces={browser.workspaces}
            assignments={browser.assignments}
            handleAssign={browser.handleAssign}
            handleEndSession={browser.handleEndSession}
            waiting={browser.waiting}
            repos={browser.repos}
            stats={browser.stats}
            visibleSessions={browser.visibleSessions}
            activePane={browser.activePane}
            worktrees={browser.worktrees}
            openNewWorktree={browser.openNewWorktree}
            openInWorktree={browser.openInWorktree}
            openPickAgent={browser.openPickAgent}
            handleRemoveWorktree={browser.handleRemoveWorktree}
            projects={browser.projectsInView}
            onOpen={show}
          />
        </WorkspaceSidebar>

        <section className="stage">
          <div className="tab-bar">
            <div className="tabs" role="tablist" aria-label="Stage">
              {strip.map((tab) => {
                if (tab.tabId === "sessions") {
                  return (
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={tabs.active === "sessions"}
                className={tabs.active === "sessions" ? "tab on" : "tab"}
                title={number(tab.tabId)}
                onClick={() =>
                  setTabs((current) => activate(current, "sessions"))
                }
              >
                Workspace
                {browser.waiting.size > 0 ? (
                  <>
                    <span className="tab-dot waiting" aria-hidden="true" />
                    <span className="sr-only"> ({browser.waiting.size} waiting)</span>
                  </>
                ) : null}
              </button>
                  );
                }
                if (tab.tabId === "terminal") {
                  return (
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={tabs.active === "terminal"}
                className={tabs.active === "terminal" ? "tab on" : "tab"}
                title={number(tab.tabId)}
                onClick={() =>
                  setTabs((current) => activate(current, "terminal"))
                }
              >
                Terminal
              </button>
                  );
                }
                const badge = badges.get(tab.tabId);
                return (
                  <button
                    key={tab.tabId}
                    type="button"
                    role="tab"
                    aria-selected={tabs.active === tab.tabId}
                    className={tabs.active === tab.tabId ? "tab on" : "tab"}
                    title={number(tab.tabId)}
                    disabled={tab.needsSession && !session}
                    onClick={() => {
                      opened(tab.tabId);
                      setTabs((current) => activate(current, tab.tabId));
                    }}
                  >
                    {tab.title}
                    {badge ? <span className="tab-badge">{badge}</span> : null}
                  </button>
                );
              })}
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
              openNew={browser.openNew}
              agents={agents}
              agentsError={agentsError}
              pickerOpen={agentPickerOpen}
              onPickerOpenChange={openAgentPicker}
              onNewAgent={() => openAgents({ mode: "new" }, true)}
              onManageAgents={() => openAgents({ mode: "edit" })}
              onNewSessionDialog={() => browser.openNewWorktree()}
              place={browser.newSessionPlace()}
            />
          </div>

          <div className="stage-body">
            {session ? (
              <TerminalView
                key={target}
                args={session.args}
                cwd={session.cwd}
                onAttached={handleAttached}
                onPane={handlePane}
                onExit={handleExit}
                active={tabs.active === "terminal"}
              />
            ) : (
              <div className="empty">
                {notice ? <p className="notice">{notice}</p> : null}
                <p className="muted">
                  Pick a session, or start a new one with {shortcutLabel.newSession()}.{" "}
                  {shortcutLabel.shortcuts()} lists every shortcut.
                </p>
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
                repos={browser.repos}
                waiting={browser.waiting}
                stats={browser.stats}
                handleEndSession={browser.handleEndSession}
                visibleSessions={browser.visibleSessions}
                visibleClaudeSessions={browser.visibleClaudeSessions}
                activePane={browser.activePane}
                openClaudeSession={browser.openClaudeSession}
                refresh={browser.refresh}
                projectsInView={browser.projectsInView}
                worktrees={browser.worktrees}
                onOpen={show}
              />
            </div>

            {/* An overlay rather than a swap: unmounting the terminal would
              close its PTY, which releases the session to whoever asks for it
              next. The terminal keeps its size too, so nothing reflows when
              the diff is on top of it. */}
            {extensionTabs
              .filter((tab) => everOpened.has(tab.tabId))
              .map((tab) => (
                <div key={tab.tabId} className="overlay ext-tab" hidden={tabs.active !== tab.tabId}>
                  <TabBody
                    entry={tab}
                    session={stageSession}
                    active={tabs.active === tab.tabId}
                    openFile={openInTab}
                    activateTab={activateTab}
                  />
                </div>
              ))}

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
          real one through `roer plugin-ui` or the `roer mcp` server — see
          src/generative-ui/ and cli/src/mcp-guide.md. */}
        {everGenerativeUI ? (
          <aside
            className={
              generativePanelCollapsed
                ? "generative-panel collapsed"
                : generativePanelResizing
                  ? "generative-panel resizing"
                  : "generative-panel"
            }
            style={generativePanelCollapsed ? undefined : { flexBasis: generativePanelWidth }}
          >
            {!generativePanelCollapsed ? (
              <div
                className="generative-resize-handle"
                onPointerDown={handleGenerativePanelResizeStart}
              />
            ) : null}
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
              onOpenFile={openInTab}
            />
          </aside>
        ) : null}

        {setup ? (
          <ClaudeSetup
            status={setup.status}
            firstRun={setup.firstRun}
            onClose={() => setSetup(null)}
          />
        ) : null}

        {agentsDialog && agents ? (
          <AgentsDialog
            list={agents}
            cwd={agentsCwd}
            start={agentsDialog.start}
            startAfterSave={agentsDialog.startAfterSave}
            onChanged={refreshAgents}
            onStart={(id) => browser.openNew(id)}
            onClose={() => setAgentsDialog(null)}
          />
        ) : null}

        {browser.picker ? (
          <NewSessionPicker
            places={browser.newSessionPlaces()}
            agents={agents}
            agentsCwd={agentsCwd}
            loadAgents={listAgents}
            start={browser.picker}
            onCreateWorktree={browser.handleCreateWorktree}
            onStart={browser.startFromPicker}
            onAttachNewProject={() => {
              browser.cancelPicker();
              void pickFolder().then((picked: string | null) => {
                if (typeof picked === "string") browser.attachNewProjectForNewSession(picked);
              });
            }}
            onClose={browser.cancelPicker}
          />
        ) : null}

        {showingExtensions ? <ExtensionsDialog onClose={() => setShowingExtensions(false)} /> : null}
        {showingShortcuts ? <ShortcutsDialog tabs={strip.slice(0, 9).map((tab) => tab.title)} onClose={() => setShowingShortcuts(false)} /> : null}

        {finding ? (
          <GoToFile
            cwd={session?.cwd}
            pane={session?.pane}
            noFiles={!session}
            sessions={sessionHits}
            roots={browser.selectedProject ? [browser.selectedProject] : browser.selectedWorkspaceProjects}
            recent={recent(tabs)}
            onOpen={openInTab}
            onClose={() => setFinding(false)}
          />
        ) : null}
      </main>
    </div>
  );
}
