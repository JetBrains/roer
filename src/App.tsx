import { message } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  BellOff,
  Globe,
  Monitor,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  PanelTop,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { loadBundled } from "./extensions/bundled";
import { useStageSession } from "./extensions/context";
import { installHost } from "./extensions/host";
import { removeExtension, setExtensionEnabled, useExternalExtensions } from "./extensions/loader";
import { confirmAction } from "./lib/confirm";
import { serveTools } from "./extensions/tools";
import { useBadges, useStageTabs } from "./extensions/registry";
import { TabBody } from "./extensions/TabBody";
import { WorkspaceSections } from "./extensions/WorkspaceSections";
import type { Scope } from "./extensions/api";
import { FileView } from "./FileView";
import { GenerativeUITab } from "./generative-ui/GenerativeUITab";
import { applyAll, applyMessage } from "./generative-ui/apply";
import { A2UI_VERSION, emptyState, surfaceIdOf, type A2uiMessage, type RenderState } from "./generative-ui/schema";
import { AgentsDialog, type AgentsDialogStart } from "./AgentsDialog";
import { ClaudeSetup } from "./ClaudeSetup";
import { UpdateNotice } from "./UpdateNotice";
import { GoToFile, type SessionHit } from "./GoToFile";
import { NewSessionButton } from "./NewSessionButton";
import { AddProjectDialog } from "./AddProjectDialog";
import { FirstProject } from "./FirstProject";
import { FolderReposDialog } from "./FolderReposDialog";
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
import { NewTabDialog } from "./NewTabDialog";
import { useAskAgent } from "./lib/askAgent";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TerminalView } from "./TerminalView";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { claudeSetupStatus, onClaudeSetupMenu, type SetupStatus } from "./lib/claudeSetup";
import {
  copyBrowserLink,
  onBrowserServerMenu,
  announceStage,
  onStageAction,
  openTabInBrowser,
  stageActionDone,
  startBrowserServer,
  tabPagePath,
} from "./lib/browserServer";
import { inDesktop } from "./lib/backend";
import { saveTabAsHtml } from "./lib/savedCopy";
import { onFilesChanged, type FilesChanged } from "./lib/files";
import { anyTakesPrompt, defaultTakesPrompt, listAgents, onAgentsMenu, type AgentList } from "./lib/agents";
import { checkForUpdate, onCheckUpdatesMenu, type UpdateStatus } from "./lib/updates";
import {
  isGoToFile,
  isMac,
  isManageAgents,
  isNewSession,
  isPickAgent,
  isNewWorktree,
  isNextWaiting,
  isCloseTab,
  isFontStep,
  isPreviousSession,
  isShortcuts,
  isTabNumber,
  fontStep,
  shortcutLabel,
  tabNumber,
  useHotkey,
  useKeymap,
} from "./lib/keys";
import { stepFontSize } from "./lib/fontSize";
import { loadKeybindings } from "./lib/keybindings";
import { useNotificationsOn } from "./lib/notify";
import { nextChoice, useThemeChoice } from "./lib/theme";
import { useSessionBrowser } from "./lib/useSessionBrowser";
import { pickFolder } from "./lib/folderPicker";
import {
  activate,
  closeTab,
  forRoot,
  noTabs,
  reorderFiles,
  openFile,
  recent,
  tabId,
  tabName,
  type Tabs,
} from "./lib/tabs";
import {
  arrange,
  loadOnly,
  loadOrder,
  place,
  saveOrder,
  scopeKeyOf,
  setPlaces,
  saveOnly,
  shownIn,
  type Only,
} from "./lib/stripLayout";
import {
  closeSide,
  loadSplit,
  openSide,
  ratioAt,
  saveSplit,
  settle,
  sideFirst,
  SPLIT_PLACES,
  splitAxis,
  type Split,
  type SplitPlace,
} from "./lib/split";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ackHandoff,
  claimHandoff,
  failHandoff,
  listSessions,
  searchClaudeSessions,
  onHandoff,
  pendingHandoffs,
  type Handoff,
  type SessionInfo,
} from "./lib/pty";
import { logLine } from "./lib/log";
import { gitRoot } from "./lib/git";
import { insideRoot } from "./lib/terminalLinks";
import { onPluginUi, reportPluginUiReceipt, type PluginUiOutcome } from "./lib/pluginUi";
import { readLoadData, useLiveLoads } from "./generative-ui/loads";

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
  /** The extension it is from; none for Workspace and Terminal. */
  extension?: string;
}

/** The side pane's place buttons: the panel the icon fills is where it goes. */
const PLACE_ICONS: Record<SplitPlace, typeof PanelLeft> = {
  left: PanelLeft,
  right: PanelRight,
  above: PanelTop,
  below: PanelBottom,
};

/** The strip's built-in tabs. Extensions' go between and after them by `order`. */
const CORE_TABS: readonly StripTab[] = [
  { tabId: "sessions", title: "Workspace", order: 0, needsSession: false },
  { tabId: "terminal", title: "Terminal", order: 10, needsSession: false },
];

/** Workspace and Terminal: moved like any tab, but always there, and never beside the terminal. */
const isCore = (tabId: string): boolean => CORE_TABS.some((tab) => tab.tabId === tabId);

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

/** A tab's menu "Open in Browser": that tab alone, as a page of its own. */
function openTabPage(page: string) {
  void openTabInBrowser(page).catch((cause: unknown) => {
    void message(String(cause), {
      title: "Could not open the tab in a browser",
      kind: "error",
    });
  });
}

/** A tab's menu "Save as HTML…": the tab as one file, read only, for someone without Roer. */
function saveTabCopy(...args: Parameters<typeof saveTabAsHtml>) {
  void saveTabAsHtml(...args).then(
    (text) => (text ? message(text, { title: "Copy saved", kind: "info" }) : undefined),
    (cause: unknown) => message(String(cause), { title: "Could not save a copy", kind: "error" }),
  );
}

/** The browser button's right-click "Copy Browser Link". */
function copyLinkForBrowser() {
  void copyBrowserLink().then(
    () =>
      message("It opens this session in one browser, once, within a minute.", {
        title: "Browser link copied",
        kind: "info",
      }),
    (cause: unknown) =>
      message(String(cause), {
        title: "Could not copy a browser link",
        kind: "error",
      }),
  );
}

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tabs>(noTabs);
  // A tab beside the stage, if one is: see lib/split.ts.
  const [split, setSplit] = useState<Split | null>(() => loadSplit());
  const [finding, setFinding] = useState(false);
  const [showingShortcuts, setShowingShortcuts] = useState(false);
  const [showingExtensions, setShowingExtensions] = useState(false);
  const [showingNewTab, setShowingNewTab] = useState(false);
  const [showingNewSection, setShowingNewSection] = useState(false);
  // The agent integrations dialog on screen, if it is: put there by the app on the
  // first launch that finds Claude Code, or asked for from the menu.
  const [setup, setSetup] = useState<{ status: SetupStatus; firstRun: boolean } | null>(null);
  // A newer release, offered in the corner until it is answered.
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
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
  // The viewer's layout of the strip (lib/stripLayout.ts): one order for
  // every Workspace, and what is hidden in each.
  const [tabOrder, setTabOrder] = useState<string[]>(loadOrder);
  const [onlyTabs, setOnlyTabs] = useState<Only>(loadOnly);
  // The tab being dragged, if one is. The strip keeps its order until the drop:
  // the tab follows the pointer and the others slide aside (handleTabPointerDown).
  const [dragging, setDragging] = useState<string | null>(null);
  const allTabs: StripTab[] = arrange(
    [...CORE_TABS, ...extensionTabs].sort((a, b) => a.order - b.order),
    tabOrder,
  );
  // Filled in once the Workspace on screen is known, below.
  const stripRef = useRef<StripTab[]>([]);
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

  // A day apart, since the app stays open for days. A check of its own that
  // fails only says so in the log; the menu's says why, or that this is the
  // latest.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const check = (automatic: boolean) =>
      checkForUpdate(automatic)
        .then((found) => {
          if (cancelled || !found) return;
          if (found.newer && !(automatic && found.skipped)) setUpdate(found);
          else if (!automatic) {
            void message(`Roer ${found.current} is the latest version.`, { title: "No update available" });
          }
        })
        .catch((cause: unknown) => {
          if (automatic) logLine(`roer: update check failed: ${String(cause)}`);
          else void message(String(cause), { title: "Could not check for updates", kind: "error" });
        });

    void onCheckUpdatesMenu(() => void check(false))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    // Not in launch's own rush.
    const first = window.setTimeout(() => void check(true), 10_000);
    const daily = window.setInterval(() => void check(true), 24 * 60 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(daily);
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
  // A view's loadData: read once, and again on its own when it asks to (generative-ui/loads.ts).
  const generativeUiRef = useRef(generativeUi);
  generativeUiRef.current = generativeUi;
  /** The repository the panel's loads read: the stage session's, once it is known. */
  const loadRootRef = useRef<string | undefined>(undefined);
  const liveLoads = useLiveLoads(
    useCallback((load, value) => {
      setGenerativeUi((current) =>
        current.live && current.state.surfaces[load.surfaceId]
          ? {
              ...current,
              state: applyMessage(current.state, {
                version: A2UI_VERSION,
                updateDataModel: { surfaceId: load.surfaceId, path: load.path, value },
              }),
            }
          : current,
      );
    }, []),
    useCallback((surfaceId: string) => Boolean(generativeUiRef.current.live && generativeUiRef.current.state.surfaces[surfaceId]), []),
    session?.pane,
  );
  const liveLoadsRef = useRef(liveLoads);
  liveLoadsRef.current = liveLoads;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    /** Where a record for this pane stands: shown, or why not. */
    const outcomeOf = (pane: string): PluginUiOutcome => {
      const onScreen = paneRef.current;
      return !onScreen ? (stagedRef.current ? "pane-unknown" : "nothing-on-screen") : pane !== onScreen ? "other-pane" : "shown";
    };

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
      // Made again: the live loads of the surface it replaces stop, and the ones sent after it start.
      if ("createSurface" in record.message || "deleteSurface" in record.message) {
        liveLoadsRef.current.forget(surfaceIdOf(record.message));
      }

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
    }, (record) => {
      const outcome = outcomeOf(record.pane);
      const load = readLoadData(record.message);
      const root = loadRootRef.current;
      const answer = (said: PluginUiOutcome) => {
        if (record.id) void reportPluginUiReceipt(record.id, said, paneRef.current).catch(() => {});
      };
      if (outcome !== "shown") return answer(outcome);
      if (load === undefined || typeof load === "string" || !root) {
        if (typeof load === "string") logLine(`roer: a loadData message was refused: ${load}`);
        return answer("invalid");
      }
      void liveLoadsRef.current.run(load, root).then((problem) => {
        if (problem) logLine(`roer: a loadData message failed: ${problem}`);
        answer(problem ? "invalid" : "shown");
      });
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
  /** Brings a tab up on the stage, which takes the keyboard back from the
   * pane beside it; the side tab itself is focused where it is (`settle`). */
  const showTab = useCallback((tabId: string) => {
    setTabs((current) => activate(current, tabId));
    setSplit((current) =>
      current && current.side !== tabId && current.focus !== "main" ? { ...current, focus: "main" } : current,
    );
  }, []);

  const activateTab = useCallback(
    (tabId: string) => {
      opened(tabId);
      showTab(tabId);
    },
    [opened, showTab],
  );

  const stageBodyRef = useRef<HTMLDivElement>(null);
  const [splitResizing, setSplitResizing] = useState(false);

  // The split's tab asked for on the stage is focused where it is instead.
  // Before paint, so the stage never flashes the tab it is about to give back.
  useLayoutEffect(() => {
    const next = settle(tabs, split);
    if (next.tabs !== tabs) setTabs(next.tabs);
    if (next.split !== split) setSplit(next.split);
  }, [tabs, split]);
  // A file closed, or gone with its session, takes the split with it.
  useEffect(() => {
    if (split?.side.startsWith("file:") && !tabs.files.some((file) => tabId(file) === split.side)) setSplit(null);
  }, [split, tabs.files]);
  // Once a drag has ended, not on every pixel of it.
  useEffect(() => {
    if (!splitResizing) saveSplit(split);
  }, [split, splitResizing]);

  const openBeside = (id: string, place?: SplitPlace) => {
    opened(id);
    const next = openSide(tabs, split, id, place);
    setTabs(next.tabs);
    setSplit(next.split);
  };
  const closeBeside = () => {
    // A split remembered from the last launch never went through `openBeside`.
    if (split) opened(split.side);
    const next = closeSide(tabs, split);
    setTabs(next.tabs);
    setSplit(next.split);
  };
  const focusPane = (focus: Split["focus"]) =>
    setSplit((current) => (current && current.focus !== focus ? { ...current, focus } : current));

  const handleSplitResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = stageBodyRef.current;
    // The primary button only: a right-click on the divider is not a drag.
    if (!body || !split || e.button !== 0) return;
    e.preventDefault();
    // Captured, so a release outside the window still ends the drag.
    const handle = e.currentTarget;
    const pointer = e.pointerId;
    handle.setPointerCapture?.(pointer);
    const { place } = split;
    const row = splitAxis(place) === "row";
    setSplitResizing(true);
    const handleMove = (ev: PointerEvent) => {
      const rect = body.getBoundingClientRect();
      const at = row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      setSplit((current) => (current ? { ...current, ratio: ratioAt(place, at) } : current));
    };
    const handleUp = () => {
      setSplitResizing(false);
      if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("blur", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    window.addEventListener("blur", handleUp);
  };

  /** A strip tab's menu: put it beside the terminal or take it back, move it, hide it, or its extension. */
  const besideMenu = (id: string, trigger: React.ReactElement) => (
    <ContextMenu key={id}>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent>
        {/* A tab out of reach without a session is not put beside the terminal either. */}
        {(isCore(id) || (allTabs.find((tab) => tab.tabId === id)?.needsSession && !session) ? [] : SPLIT_PLACES)
          .filter(({ place }) => split?.side !== id || split.place !== place)
          .map(({ place, label }) => (
            <ContextMenuItem key={place} onSelect={() => openBeside(id, place)}>
              {split?.side === id ? "Move" : "Open"} {label.toLowerCase()}
            </ContextMenuItem>
          ))}
        {split?.side === id ? <ContextMenuItem onSelect={closeBeside}>Back to the stage</ContextMenuItem> : null}
        {/* A tab that needs a session takes the stage's along, and stays on it there. */}
        {inDesktop() && extensionTabs.some((tab) => tab.tabId === id && (!tab.needsSession || session?.pane)) ? (
          <ContextMenuItem
            onSelect={() =>
              openTabPage(
                tabPagePath(id, extensionTabs.find((tab) => tab.tabId === id)?.needsSession ? stagedNow() : null),
              )
            }
          >
            Open in Browser
          </ContextMenuItem>
        ) : null}
        {(() => {
          const tab = extensionTabs.find((one) => one.tabId === id);
          if (!tab || (tab.needsSession && !stageSession)) return null;
          const at = tab.needsSession && stageSession
            ? { cwd: stageSession.root ?? stageSession.cwd ?? "", root: stageSession.root, branch: stageSession.branch }
            : null;
          return <ContextMenuItem onSelect={() => saveTabCopy(tab, at)}>Save as HTML…</ContextMenuItem>;
        })()}
        {isCore(id) ? null : <ContextMenuSeparator />}
        <ContextMenuItem onSelect={() => nudgeTab(id, -1)}>Move left</ContextMenuItem>
        <ContextMenuItem onSelect={() => nudgeTab(id, 1)}>Move right</ContextMenuItem>
        {extensionOf(id) ? (
          <>
            {here ? (
              <>
                {places.length > 1 ? (
                  <ContextMenuItem onSelect={() => hideHere(id)}>Hide in this {where}</ContextMenuItem>
                ) : null}
                {onlyTabs[id] ? (
                  <ContextMenuItem onSelect={() => keepOnly(setPlaces(onlyTabs, id, null))}>
                    Show in every Workspace
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem onSelect={() => keepOnly(setPlaces(onlyTabs, id, [here]))}>
                    Show only in this {where}
                  </ContextMenuItem>
                )}
              </>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void switchOffExtension(id)}>Switch off everywhere</ContextMenuItem>
            {id.startsWith("ext:") ? (
              <ContextMenuItem onSelect={() => void removeExtensionOf(id)}>Remove extension…</ContextMenuItem>
            ) : null}
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );

  // What is beside the stage: an extension's tab, or a file. An extension's
  // that has not loaded (yet) leaves the stage whole until it does.
  const sideExt = split ? extensionTabs.find((tab) => tab.tabId === split.side) : undefined;
  const sideFile = split ? tabs.files.find((file) => tabId(file) === split.side) : undefined;
  const beside = split && (sideExt || sideFile) ? split : null;
  const mainFocused = !beside || beside.focus === "main";

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

  /** A path the terminal linked (Claude Code's OSC 8), opened in Roer's file
   * view under the repository it belongs to, or its own folder outside one. */
  const openLinkedFile = useCallback(
    (path: string, line?: number) => {
      // `C:` alone is the current directory on that drive, not its root.
      const dir = path.replace(/[\\/][^\\/]*$/, "").replace(/^([A-Za-z]:)$/, "$1/") || "/";
      void gitRoot(dir)
        .catch(() => null)
        .then((root) => {
          // git can spell the root another way than the link does (a
          // symlink resolved, a drive letter's case); then the file's folder.
          const inRepo = root ? insideRoot(root, path) : null;
          const [base, rel] = root && inRepo ? [root, inRepo] : [dir, insideRoot(dir, path)];
          if (rel) openInTab(base, rel, line);
          else logLine(`roer: a terminal link to ${path} names no file Roer can open`);
        });
    },
    [openInTab],
  );

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

  const handleExit = useCallback((code: number | null, early?: string) => {
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
    // Refused before it ever attached: roer said why in a terminal that has
    // gone with it, so it is said here instead.
    if (gone && early !== undefined && code !== 0) {
      const said = early
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      setNotice(`Could not open it: ${said ?? `roer exited with ${code ?? "a signal"}`}`);
      return;
    }
    if (gone) void describeExit(gone).then(setNotice);
  }, [describeExit, drain]);

  // The Workspace sidebar and the session browser are two places on screen
  // for one piece of state — which Workspace is selected, and what it
  // filters — so one hook call feeds both rather than each keeping its own.
  // The person's own keys, from last time; every title and hint that names
  // a key says the one that works once they are in.
  useKeymap();
  useEffect(() => {
    void loadKeybindings();
  }, []);

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

  // A tab's way to a new session on a prompt, such as Changes asking for a review: with the default agent, or asked
  // which one when the tab wants that or the default cannot be handed a prompt. Offered where some agent can. The
  // default is `cwd`'s own, which another project's agents may set apart from the ones read for here; the picker
  // reads that folder's itself.
  const startSession = anyTakesPrompt(agents)
    ? async (cwd: string, prompt: string, options?: { pickAgent?: boolean }) => {
        if (!options?.pickAgent) {
          const there = cwd === agentsCwd ? agents : await listAgents(cwd).catch(() => null);
          if (defaultTakesPrompt(there)) {
            browser.openNewAt(cwd, prompt);
            return true;
          }
        }
        void refreshAgents();
        return browser.openPickAgentAt(cwd, prompt);
      }
    : undefined;
  // The live sessions a tab can send to, such as Changes sending decisions to the session that asked for a review.
  const agentSessions = browser.allSessions.flatMap((live) => {
    const agent = runningAgent(live);
    return agent ? [{ pane: live.pane, id: live.id, agent, cwd: live.cwd }] : [];
  });

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
        showTab(tab.tabId);
      },
      [opened, showTab],
    ),
  );


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
  /** The stage's session as a browser page names it, once its pane is known. */
  const stagedNow = () => {
    if (!session?.pane) return null;
    const live = browser.allSessions.find((one) => one.pane === session.pane);
    return { pane: session.pane, id: live?.id, cwd: session.cwd };
  };
  // Told to the browser pages that follow the stage (see TabPage), each time it moves.
  const stagedPane = session?.pane;
  const stagedCwd = session?.cwd;
  const stagedId = browser.allSessions.find((one) => one.pane === stagedPane)?.id;
  useEffect(() => {
    if (!inDesktop()) return;
    void announceStage(stagedPane ? { pane: stagedPane, id: stagedId, cwd: stagedCwd } : null).catch(() => undefined);
  }, [stagedPane, stagedId, stagedCwd]);

  // What a tab opened in a browser asks of the stage (see TabPage): the
  // window has already come forward, so it happens where it is seen.
  const stageActsRef = useRef({ activateTab, attach, startSession });
  stageActsRef.current = { activateTab, attach, startSession };
  useEffect(() => {
    if (!inDesktop()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onStageAction((action) => {
      const acts = stageActsRef.current;
      if (action.kind === "activateTab") acts.activateTab(action.tabId);
      else if (action.kind === "showSession") acts.attach(action.pane);
      else if (action.kind === "startSession") {
        // No agent here can be handed a prompt: the page hears so rather than that it started.
        const started = acts.startSession
          ? acts.startSession(action.cwd, action.prompt, { pickAgent: action.pickAgent }).catch(() => false)
          : Promise.resolve(false);
        const request = action.request;
        if (request) void started.then((ok) => stageActionDone({ request, ok })).catch(() => undefined);
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Cmd+W closes the smallest thing in view: the file tab on top, and on
  // the Terminal the session, released rather than ended, so it is still in
  // the Workspace to come back to. Changes and an extension's tab are views
  // of the session rather than the session, so they stay put; so does
  // everything under a dialog, which is what the key would seem to be for.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useHotkey(
    isCloseTab,
    useCallback(() => {
      if (document.querySelector('[role="dialog"]')) return;
      const { active, files } = tabsRef.current;
      if (files.some((file) => tabId(file) === active)) setTabs((current) => closeTab(current, active));
      else if (active === "terminal" && stagedRef.current) handleExit(null);
    }, [handleExit]),
  );
  // The text size of whichever pane has the keyboard: the Terminal's, or
  // the code's for anything else on the stage.
  const splitRef = useRef(split);
  splitRef.current = split;
  useHotkey(
    isFontStep,
    useCallback((event: KeyboardEvent) => {
      const step = fontStep(event);
      if (step === null) return;
      const side = splitRef.current?.focus === "side" ? splitRef.current.side : null;
      stepFontSize((side ?? tabsRef.current.active) === "terminal" ? "terminal" : "code", step);
    }, []),
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
    // Polled with the live list, so a `cd` with no edit after it still moves the tabs to the new repository.
    liveCwd: onStage?.cwd,
  });
  const agentState = onStage && runningAgent(onStage) ? onStage.state : undefined;
  loadRootRef.current = stageSession?.root ?? session?.cwd;
  // What the Workspace tab is about, as its extension sections see it. The
  // same answer keeps the same object, so a section's effects run again only
  // when the Workspace or Project, its repositories or its folder change.
  const scopeNow: Scope | null = browser.selectedProject
    ? {
        kind: "project",
        id: browser.selectedProject.id,
        name: browser.selectedProject.name,
        projects: [{ name: browser.selectedProject.name, path: browser.selectedProject.path }],
        folder: null,
      }
    : browser.selectedWorkspace
      ? {
          kind: "workspace",
          id: browser.selectedWorkspace.id,
          name: browser.selectedWorkspace.name,
          projects: browser.selectedWorkspaceProjects.map(({ name, path }) => ({ name, path })),
          folder: browser.selectedWorkspace.folder ?? null,
        }
      : null;
  const scopeKey = JSON.stringify(scopeNow);
  const scope = useMemo(() => scopeNow, [scopeKey]);

  // The strip as shown here: the tabs kept to other Workspaces and Projects left out.
  const here = scopeKeyOf(scope);
  const strip = allTabs.filter((tab) => shownIn(tab.tabId, here, onlyTabs));
  const where = scope?.kind === "project" ? "Project" : "Workspace";
  stripRef.current = strip;
  // Everywhere a tab can be kept to, for the Extensions dialog's picker.
  const places = [
    ...browser.workspaces.map((one) => ({ key: `workspace:${one.id}`, name: one.name, kind: "Workspace" as const })),
    ...browser.projects.map((one) => ({ key: `project:${one.id}`, name: one.name, kind: "Project" as const })),
  ];

  const keepOnly = (next: Only) => {
    setOnlyTabs(next);
    saveOnly(next);
  };
  /** Keeps tabs to `keys`, or, with null, shows them everywhere again. */
  const placeTab = (id: string, keys: readonly string[] | null) => {
    keepOnly(setPlaces(onlyTabs, id, keys));
    // A tab not shown here is not beside the stage here either.
    if (here && keys?.length && !keys.includes(here) && split?.side === id) setSplit(null);
  };
  /** Everywhere the tab is now, but here. */
  const hideHere = (id: string) => {
    if (!here) return;
    placeTab(
      id,
      (onlyTabs[id] ?? places.map((one) => one.key)).filter((key) => key !== here),
    );
  };

  /** The extension behind a strip tab, with its name for the menu's questions. */
  const extensionOf = (id: string) => {
    const tab = allTabs.find((one) => one.tabId === id);
    return tab?.extension ? { id: tab.extension, title: tab.title } : undefined;
  };
  const failed = (title: string) => (cause: unknown) => void message(String(cause), { title, kind: "error" });
  /** Off in every Workspace, its other tabs and sections too, until it is switched on in Extensions. */
  const switchOffExtension = (id: string) => {
    const ext = extensionOf(id);
    if (ext) return setExtensionEnabled(ext.id, false).catch(failed(`Could not switch off ${ext.title}`));
  };
  /** Out of Roer altogether, once asked: a built-in one can only be switched off. */
  const removeExtensionOf = async (id: string) => {
    const ext = extensionOf(id);
    if (!ext) return;
    const sure = await confirmAction(
      `Remove the extension behind ${ext.title}? Its tabs, Workspace sections and tools go from every Workspace. ` +
        "Its files are moved to ~/.roer/extensions-removed, not deleted.",
      `Remove ${ext.title}?`,
    );
    if (sure) await removeExtension(ext.id).catch(failed(`Could not remove ${ext.title}`));
  };

  /** Every strip tab, as the strip arranges them, hidden ones too: what an order is saved over. */
  const stripOrder = allTabs.map((tab) => tab.tabId);
  const fileOrder = tabs.files.map(tabId);
  const saveTabOrder = (order: string[]) => {
    setTabOrder(order);
    saveOrder(order);
  };
  /** Puts the file tabs in `order`, for this session only: file tabs are not kept across launches. */
  const orderFiles = (order: readonly string[]) => setTabs((current) => reorderFiles(current, order));
  /** Swaps a tab with the one shown next to it in its group, the menu's Move left and right. */
  const nudgeTab = (id: string, by: -1 | 1) => {
    const file = id.startsWith("file:");
    const shown = file ? fileOrder : strip.map((tab) => tab.tabId);
    const target = shown[shown.indexOf(id) + by];
    if (!target) return;
    const order = place(file ? fileOrder : stripOrder, id, target, by < 0 ? "before" : "after");
    if (file) orderFiles(order);
    else saveTabOrder(order);
  };

  // A drag that moved is not a click as well.
  const draggedRef = useRef(false);
  /**
   * Drags a tab along the strip: Workspace, Terminal and extensions' tabs
   * among themselves, file tabs among themselves. By pointer rather than HTML
   * drag and drop, which the webview hands to the file drop when it is on.
   * The strip shows the new order as it goes; it is kept on release, and
   * dropped if the window loses the pointer first.
   */
  const handleTabPointerDown = (e: React.PointerEvent<HTMLElement>, id: string) => {
    const stripEl = tabStripRef.current;
    if (!stripEl || e.button !== 0) return;
    const group = id.startsWith("file:") ? "file" : "strip";
    const startX = e.clientX;
    const pointer = e.pointerId;
    const handle = e.currentTarget;
    const ids = group === "file" ? fileOrder : stripOrder;
    // Measured once, where everything stood when the drag began: the others
    // only ever slide by transforms, which leave the layout where it was.
    const all = [...stripEl.querySelectorAll<HTMLElement>(`[data-drag="${group}"]`)];
    const from = all.findIndex((el) => el.dataset.tabId === id);
    if (from < 0) return;
    const rects = all.map((el) => el.getBoundingClientRect());
    const others = all.filter((_, at) => at !== from);
    const centres = rects.filter((_, at) => at !== from).map((rect) => rect.left + rect.width / 2);
    const own = rects[from];
    // How far a neighbour slides to make room: the tab's width and the gap after it.
    const step = own.width + (rects[from + 1] ? rects[from + 1].left - own.right : rects[from - 1] ? own.left - rects[from - 1].right : 0);
    // Not past either end of its group.
    const minDx = rects[0].left - own.left;
    const maxDx = rects[rects.length - 1].right - own.right;
    let started = false;
    let at = from;
    const handleMove = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < 5) return;
      if (!started) {
        started = true;
        handle.setPointerCapture?.(pointer);
        setDragging(id);
        for (const el of others) el.classList.add("drag-shift");
      }
      const dx = ev.clientX - startX;
      handle.style.transform = `translateX(${Math.max(minDx, Math.min(maxDx, dx))}px)`;
      // Where it lands goes by the pointer, not by where the tab is drawn: a tab
      // wider than the last one could never pass that one's middle otherwise.
      const centre = own.left + own.width / 2 + dx;
      at = centres.filter((one) => one < centre).length;
      others.forEach((el, k) => {
        const shift = k < from && k >= at ? step : k >= from && k < at ? -step : 0;
        el.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };
    const finish = (keep: boolean) => () => {
      // Back in place without sliding, in the same frame the new order is drawn.
      for (const el of all) {
        el.classList.remove("drag-shift");
        el.style.transform = "";
      }
      if (started) {
        const target = others[Math.min(at, others.length - 1)]?.dataset.tabId;
        if (keep && target && at !== from) {
          const order = place(ids, id, target, at < others.length ? "before" : "after");
          if (group === "strip") saveTabOrder(order);
          else orderFiles(order);
        }
        draggedRef.current = true;
        window.setTimeout(() => (draggedRef.current = false), 0);
      }
      setDragging(null);
      if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
    const up = finish(true);
    const cancel = finish(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };
  /** What makes a tab draggable, and how the strip finds it while another is dragged. */
  const dragProps = (id: string) => ({
    "data-drag": id.startsWith("file:") ? "file" : "strip",
    "data-tab-id": id,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => handleTabPointerDown(e, id),
  });

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

  // The strip has no scrollbar, so the tab picked is brought into view, and
  // a mouse's wheel scrolls it sideways as a trackpad does.
  const tabStripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabStripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tabs.active, stripIds]);
  const scrollTabStrip = (event: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
  };
  // Asks the agent on stage for a tab. Here rather than in the dialog, since
  // a request made while the agent works waits after the dialog is gone.
  const askAgent = useAskAgent(session?.pane, agentState);
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
        conversation: live.pid ? browser.paneConversations.get(live.pid) : undefined,
        live: true,
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
      conversation: past,
      open: () => browser.openClaudeSession(past),
    })),
  ];
  // Past conversations found by what was said in them, keyed as their hits
  // above are; looked for where the session browser looks for them.
  const conversationCwds = browser.conversationCwds;
  const searchSessions = useCallback(
    async (query: string) =>
      new Map(
        (await searchClaudeSessions(conversationCwds, query)).map((hit) => [`resume:${hit.id}`, hit.snippet] as const),
      ),
    [conversationCwds],
  );
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

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              className="browser-toggle"
              aria-label="Open this session in a browser"
              title="Open this session in a browser (right-click to copy a link)"
              onClick={openInBrowser}
            >
              <Globe size={15} />
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={copyLinkForBrowser}>Copy Browser Link</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

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
          className="shortcuts-toggle"
          aria-label="Keyboard shortcuts"
          title={`Keyboard shortcuts (${shortcutLabel.shortcuts()})`}
          aria-pressed={showingShortcuts}
          onClick={() => setShowingShortcuts((open) => !open)}
        >
          <Settings size={15} />
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
          handleSetWorkspaceFolder={browser.handleSetWorkspaceFolder}
          openAddProject={browser.openAddProject}
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
            folderInView={browser.folderInView}
            projects={browser.projectsInView}
            onOpen={show}
            onAddProject={browser.projects.length > 0 ? () => browser.openAddProject() : undefined}
          />
        </WorkspaceSidebar>

        <section className="stage">
          <div className="tab-bar">
            <div ref={tabStripRef} className="tabs" role="tablist" aria-label="Stage" onWheel={scrollTabStrip}>
              {strip.map((tab) => {
                const dragClass = dragging === tab.tabId ? " dragging" : "";
                if (tab.tabId === "sessions") {
                  return besideMenu(
                    tab.tabId,
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={tabs.active === "sessions"}
                className={(tabs.active === "sessions" ? "tab on" : "tab") + dragClass}
                title={number(tab.tabId)}
                {...dragProps(tab.tabId)}
                onClick={() => !draggedRef.current && showTab("sessions")}
              >
                Workspace
                {browser.waiting.size > 0 ? (
                  <>
                    <span className="tab-dot waiting" aria-hidden="true" />
                    <span className="sr-only"> ({browser.waiting.size} waiting)</span>
                  </>
                ) : null}
              </button>,
                  );
                }
                if (tab.tabId === "terminal") {
                  return besideMenu(
                    tab.tabId,
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={tabs.active === "terminal"}
                className={(tabs.active === "terminal" ? "tab on" : "tab") + dragClass}
                title={number(tab.tabId)}
                {...dragProps(tab.tabId)}
                onClick={() => !draggedRef.current && showTab("terminal")}
              >
                Terminal
              </button>,
                  );
                }
                const badge = badges.get(tab.tabId);
                const beside = split?.side === tab.tabId;
                return besideMenu(
                  tab.tabId,
                  <button
                    key={tab.tabId}
                    type="button"
                    role="tab"
                    aria-selected={tabs.active === tab.tabId}
                    className={[
                      "tab",
                      tabs.active === tab.tabId ? "on" : beside ? "beside" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") + dragClass}
                    title={number(tab.tabId)}
                    // Not `disabled`, which would take its menu away as well: a tab out of
                    // reach until there is a session can still be moved, hidden or removed.
                    aria-disabled={tab.needsSession && !session ? true : undefined}
                    {...dragProps(tab.tabId)}
                    onClick={() => {
                      if (draggedRef.current || (tab.needsSession && !session)) return;
                      opened(tab.tabId);
                      showTab(tab.tabId);
                    }}
                  >
                    {tab.title}
                    {badge ? <span className="tab-badge">{badge}</span> : null}
                  </button>,
                );
              })}
              {tabs.files.map((file) => {
                const id = tabId(file);
                const name = tabName(file);
                return besideMenu(
                  id,
                  // The tab and its close button are two controls, so they are two
                  // buttons; the wrapper is what looks like one tab.
                  <span
                    className={
                      (tabs.active === id ? "tab-wrap on" : split?.side === id ? "tab-wrap beside" : "tab-wrap") +
                      (dragging === id ? " dragging" : "")
                    }
                    {...dragProps(id)}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tabs.active === id}
                      className="tab file"
                      title={file.path}
                      onClick={() => !draggedRef.current && showTab(id)}
                    >
                      {name}
                    </button>
                    <button
                      type="button"
                      className="tab-x"
                      aria-label={`Close ${name}`}
                      onClick={() => !draggedRef.current && setTabs((current) => closeTab(current, id))}
                    >
                      ×
                    </button>
                  </span>,
                );
              })}
              <button
                type="button"
                className="tab-add"
                aria-label="New tab…"
                title={
                  askAgent.held.length > 0
                    ? `${askAgent.held.length} waiting for the agent: ${askAgent.held.map((request) => request.label).join("; ")}`
                    : "New tab: ask the agent to make one"
                }
                onClick={() => setShowingNewTab(true)}
              >
                <Plus size={14} />
                {askAgent.held.length > 0 ? <span className="tab-badge">{askAgent.held.length}</span> : null}
              </button>
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

          <div
            ref={stageBodyRef}
            className={
              beside
                ? `stage-body split ${splitAxis(beside.place)}${sideFirst(beside.place) ? " side-first" : ""}${splitResizing ? " resizing" : ""}`
                : "stage-body"
            }
          >
          {/* Always this wrapper, split or not: a new parent would remount the
            terminal, and with it its PTY. */}
          <div
            className={beside && beside.focus === "main" ? "stage-pane focused" : "stage-pane"}
            style={beside ? { flexBasis: `${beside.ratio * 100}%` } : undefined}
            onPointerDownCapture={() => focusPane("main")}
            // A drop of files focuses the terminal without a press on it.
            onFocusCapture={() => focusPane("main")}
          >
            {session ? (
              <TerminalView
                key={target}
                args={session.args}
                cwd={session.cwd}
                onAttached={handleAttached}
                onPane={handlePane}
                onExit={handleExit}
                onOpenFile={openLinkedFile}
                active={tabs.active === "terminal" && mainFocused}
                shown={tabs.active === "terminal"}
              />
            ) : (
              <div className="empty">
                {notice ? <p className="notice">{notice}</p> : null}
                {/* Behind the Workspace tab it is that tab's to say. */}
                {browser.asksForFolder() && tabs.active !== "sessions" ? (
                  <FirstProject
                    onClone={() => browser.openAddProject({ mode: "clone" })}
                    onFolder={() => browser.openNew()}
                    onHome={browser.openNewInHome}
                  />
                ) : null}
                <p className="muted" hidden={browser.asksForFolder()}>
                  Pick a session, or start a new one with {shortcutLabel.newSession()}.{" "}
                  {shortcutLabel.shortcuts()} lists every shortcut.
                </p>
              </div>
            )}

            {/* Covers the terminal rather than replacing it, so picking a
              session never has to wait on a teardown, and a session left
              running behind the list keeps its PTY. */}
            <div className="overlay workspace-overlay" hidden={tabs.active !== "sessions"}>
              <SessionBrowser
                status={browser.status}
                workspaces={browser.workspaces}
                projects={browser.projects}
                assignments={browser.assignments}
                selectedWorkspace={browser.selectedWorkspace}
                selectedWorkspaceProjects={browser.selectedWorkspaceProjects}
                handleAssign={browser.handleAssign}
                openAddProject={browser.openAddProject}
                handleAddProject={browser.handleAddProject}
                openNewInHome={browser.openNewInHome}
                handleDetachProject={browser.handleDetachProject}
                handleRenameProject={browser.handleRenameProject}
                openNewIn={browser.openNewIn}
                openPickAgent={browser.openPickAgent}
                roots={browser.roots}
                repos={browser.repos}
                waiting={browser.waiting}
                stats={browser.stats}
                handleEndSession={browser.handleEndSession}
                visibleSessions={browser.visibleSessions}
                visibleClaudeSessions={browser.visibleClaudeSessions}
                activePane={browser.activePane}
                openClaudeSession={browser.openClaudeSession}
                conversationCwds={browser.conversationCwds}
                refresh={browser.refresh}
                projectsInView={browser.projectsInView}
                folderInView={browser.folderInView}
                worktrees={browser.worktrees}
                onOpen={show}
              />
              {/* Docked under the list rather than at its end, where a long
                list of sessions would put them out of sight. */}
              {scope ? (
                <WorkspaceSections
                  scope={scope}
                  session={stageSession}
                  active={tabs.active === "sessions"}
                  openFile={openInTab}
                  activateTab={activateTab}
                  startSession={startSession}
                  sessions={agentSessions}
                  showSession={attach}
                  onAddSection={() => setShowingNewSection(true)}
                />
              ) : null}
            </div>

            {/* An overlay rather than a swap: unmounting the terminal would
              close its PTY, which releases the session to whoever asks for it
              next. The terminal keeps its size too, so nothing reflows when
              the diff is on top of it. */}
            {extensionTabs
              .filter((tab) => everOpened.has(tab.tabId) && tab !== sideExt)
              .map((tab) => (
                <div key={tab.tabId} className="overlay ext-tab" hidden={tabs.active !== tab.tabId}>
                  <TabBody
                    entry={tab}
                    session={stageSession}
                    scope={scope}
                    active={tabs.active === tab.tabId}
                    focused={tabs.active === tab.tabId && mainFocused}
                    openFile={openInTab}
                    activateTab={activateTab}
                    startSession={startSession}
                    sessions={agentSessions}
                    showSession={attach}
                  />
                </div>
              ))}

            {/* Open is mounted, for the same reason: a file tab keeps its scroll
              position while you are away in the terminal. */}
            {tabs.files.filter((file) => file !== sideFile).map((file) => {
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

          {beside ? (
            <>
              <div
                className="split-divider"
                role="separator"
                aria-orientation={splitAxis(beside.place) === "row" ? "vertical" : "horizontal"}
                title="Drag to resize, double-click to even out"
                onPointerDown={handleSplitResizeStart}
                onDoubleClick={() => setSplit((current) => (current ? { ...current, ratio: 0.5 } : current))}
              />
              <div
                className={beside.focus === "side" ? "stage-pane side focused" : "stage-pane side"}
                onPointerDownCapture={() => focusPane("side")}
              >
                <div className="split-head">
                  <span className="split-title">{sideExt ? sideExt.title : sideFile ? tabName(sideFile) : ""}</span>
                  {SPLIT_PLACES.map(({ place, label }) => {
                    const Glyph = PLACE_ICONS[place];
                    return (
                      <button
                        key={place}
                        type="button"
                        className={beside.place === place ? "split-tool on" : "split-tool"}
                        title={label}
                        aria-label={label}
                        aria-pressed={beside.place === place}
                        onClick={() => openBeside(beside.side, place)}
                      >
                        <Glyph size={14} />
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="split-tool"
                    title="Back to the stage"
                    aria-label="Back to the stage"
                    onClick={closeBeside}
                  >
                    ×
                  </button>
                </div>
                <div className="split-body ext-tab">
                  {sideExt ? (
                    <TabBody
                      entry={sideExt}
                      session={stageSession}
                      scope={scope}
                      active
                      focused={beside.focus === "side"}
                      openFile={openInTab}
                      activateTab={activateTab}
                      startSession={startSession}
                      sessions={agentSessions}
                      showSession={attach}
                    />
                  ) : sideFile ? (
                    <FileView
                      root={sideFile.root}
                      path={sideFile.path}
                      line={sideFile.line}
                      active
                      changed={changed}
                    />
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
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
              agentState={agentState}
              onOpenTab={activateTab}
              onNewTab={() => setShowingNewTab(true)}
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

        {update ? <UpdateNotice update={update} onClose={() => setUpdate(null)} /> : null}

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

        {browser.addProject ? (
          <AddProjectDialog
            start={browser.addProject}
            workspaces={browser.workspaces}
            projects={browser.projects}
            home={browser.status?.home}
            parentFor={browser.projectParent}
            onAdd={browser.handleAddProject}
            onClose={browser.closeAddProject}
          />
        ) : null}

        {browser.folderRepos ? (
          <FolderReposDialog
            asked={browser.folderRepos}
            workspaceName={browser.workspaces.find((workspace) => workspace.id === browser.folderRepos?.workspaceId)?.name}
            onConfirm={(repos, into) => void browser.confirmFolderRepos(repos, into)}
            onClose={browser.cancelFolderRepos}
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

        {showingExtensions ? (
          <ExtensionsDialog
            onClose={() => setShowingExtensions(false)}
            placement={{
              places,
              tabs: allTabs.flatMap((tab) => (tab.extension ? [{ tabId: tab.tabId, extension: tab.extension, title: tab.title }] : [])),
              only: onlyTabs,
              place: placeTab,
            }}
            onNewTab={() => {
              setShowingExtensions(false);
              setShowingNewTab(true);
            }}
          />
        ) : null}
        {showingNewTab ? (
          <NewTabDialog
            agent={askAgent}
            agentState={agentState}
            stageName={stageName}
            newSession={{ place: browser.newSessionPlace(), ready: defaultTakesPrompt(agents) }}
            onNewSession={(prompt) => browser.openNew(undefined, prompt)}
            onClose={() => setShowingNewTab(false)}
          />
        ) : null}
        {showingNewSection ? (
          <NewTabDialog
            agent={askAgent}
            agentState={agentState}
            kind="section"
            stageName={stageName}
            newSession={{ place: browser.newSessionPlace(), ready: defaultTakesPrompt(agents) }}
            onNewSession={(prompt) => browser.openNew(undefined, prompt)}
            onClose={() => setShowingNewSection(false)}
          />
        ) : null}
        {showingShortcuts ? <ShortcutsDialog tabs={strip.slice(0, 9).map((tab) => tab.title)} onClose={() => setShowingShortcuts(false)} /> : null}

        {finding ? (
          <GoToFile
            cwd={session?.cwd}
            pane={session?.pane}
            noFiles={!session}
            sessions={sessionHits}
            searchSessions={searchSessions}
            conversationCwds={browser.conversationCwds}
            home={browser.status?.home}
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
