import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { closePty, decodeOutput, noteTyped, resizePty, spawnPty, writePty } from "./lib/pty";
import { onFileDrag } from "./lib/backend";
import { isOver, pathsAsTyped } from "./lib/fileDrop";
import { openUrl } from "./lib/github";
import { logLine } from "./lib/log";
import { isOpenGesture, linkTarget } from "./lib/terminalLinks";
import { measureWithUnicode11 } from "./lib/unicodeWidth";
import { currentTheme, hostColors, onThemeChange, terminalTheme } from "./lib/theme";

/**
 * How long output has to keep flowing before the session counts as attached.
 * Long enough to outlive an attach that fails and exits, short enough not to
 * be felt.
 */
const ATTACH_GRACE_MS = 250;

/** The private OSC `roer` writes, when the app runs it, just before attaching:
 * `ESC ] 7717 ; pane=%N BEL`, or `pane==session:.%N` on psmux, where a pane id
 * alone does not say which session's pane it is. */
const PANE_OSC = 7717;

/** How far the pointer may move between press and release for a click on a
 * link to count as one, in CSS pixels. */
const DRAG_PX = 4;

/** How long a plain click on a link waits for a second one, which makes it a
 * double-click selecting a word instead. Cmd+click opens at once. */
const DOUBLE_CLICK_MS = 300;

/** Writes and resizes race with the session ending; that rejection is normal. */
function ignoreClosed() {
  /* no-op */
}

export interface TerminalViewProps {
  /** Arguments to the `roer` shim: ["shell"] for mode 1, ["attach", pane] for mode 2. */
  args: readonly string[];
  cwd?: string;
  /** Fires once the PTY has produced output and stayed alive, so the session
   * is really on screen. */
  onAttached?: () => void;
  /** The pane `roer` attached, as it said in the terminal before attaching:
   * how a session started here learns its pane. */
  onPane?: (pane: string) => void;
  /** The PTY ended. After a handoff this is a terminal taking the session back. */
  onExit?: (code: number | null) => void;
  /** A `file:` link was Cmd+clicked (Ctrl+click elsewhere): the absolute
   * path it names, and the line when it gives one. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Whether the terminal is on top of the stage. It takes the keyboard
   * whenever it comes to the front, so a session just opened can be typed
   * into without clicking it first. */
  active?: boolean;
  /** Whether the terminal is on screen, focused or not: beside a tab that
   * has the keyboard, it still takes files dropped on it. */
  shown?: boolean;
}

/**
 * Hosts the xterm.js instance and binds it to a PTY in the Rust backend.
 * The terminal owns its DOM node, so React only supplies the container.
 */
/** Whether a key can leave text in a prompt: a character, or an edit of one. */
export const leavesDraft = (event: KeyboardEvent): boolean =>
  !event.ctrlKey && !event.metaKey && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete");

export function TerminalView({ args, cwd, onAttached, onPane, onExit, onOpenFile, active = true, shown = active }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Args and callbacks are read through refs so a parent re-render can never
  // tear down a live session; only a genuinely different target should.
  const argsRef = useRef(args);
  argsRef.current = args;
  const onAttachedRef = useRef(onAttached);
  onAttachedRef.current = onAttached;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onPaneRef = useRef(onPane);
  onPaneRef.current = onPane;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const target = args.join(" ");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: terminalTheme(currentTheme()),
      // For `terminal.unicode`, which xterm still marks as proposed.
      allowProposedApi: true,
      // OSC 8 links, which Claude Code writes around the URLs and paths it
      // prints. Without a handler xterm asks with confirm() and calls
      // window.open, and neither does anything in Roer's window.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, uri) => clickLink(event, uri),
      },
    });
    /** Opens what a link names: a web page in the browser, a file in Roer. */
    const openLink = (uri: string) => {
      const target = linkTarget(uri);
      if (target?.kind === "web") {
        openUrl(target.url).catch((e: unknown) => logLine(`roer: could not open ${target.url}: ${String(e)}`));
      } else if (target?.kind === "file") {
        onOpenFileRef.current?.(target.path, target.line);
      }
    };
    // Where the last press went down, and whether the terminal had the
    // keyboard then. tmux's `mouse on` does the selecting, so xterm never
    // knows a drag made one: the pointer has to say a click was a click.
    let press: { x: number; y: number; focused: boolean } | null = null;
    let pendingOpen: ReturnType<typeof setTimeout> | undefined;
    const onPress = (event: MouseEvent) => {
      // A second press is a double-click, selecting a word, not an open.
      clearTimeout(pendingOpen);
      press = { x: event.clientX, y: event.clientY, focused: container.contains(document.activeElement) };
    };
    container.addEventListener("mousedown", onPress, { capture: true });
    /** A link clicked: opened unless the click was the end of a drag, the
     * one that brought the terminal into focus, or half of a double-click. */
    const clickLink = (event: MouseEvent, uri: string) => {
      if (!isOpenGesture(event) || !press) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_PX) return;
      // Cmd+click (Ctrl+click elsewhere) means it: no waiting.
      if (event.metaKey || event.ctrlKey) return openLink(uri);
      if (!press.focused) return;
      pendingOpen = setTimeout(() => openLink(uri), DOUBLE_CLICK_MS);
    };
    // Plain URLs in the output, which nothing marked as links.
    terminal.loadAddon(new WebLinksAddon((event, uri) => clickLink(event, uri)));
    measureWithUnicode11(terminal);
    const unfollowTheme = onThemeChange((theme) => {
      terminal.options.theme = terminalTheme(theme);
    });
    // Which pane the keys go to, for `noteTyped`: known up front when
    // attaching, and from roer's report when it starts a session.
    let pane = argsRef.current[0] === "attach" ? argsRef.current[1] : undefined;
    // Handled, so never drawn, whatever it says; only a pane id is passed on.
    const paneSub = terminal.parser.registerOscHandler(PANE_OSC, (data) => {
      // The session part as roer's is_pane_id holds it: no `:`, quotes or
      // control characters.
      const reported = /^pane=((?:=[^:'"`\x00-\x1f]+:\.)?%\d+)$/.exec(data)?.[1];
      logLine(`terminal ${target}: roer reported ${reported ?? `an unreadable pane (${data})`}`);
      if (reported) {
        pane = reported;
        onPaneRef.current?.(reported);
      }
      return true;
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminalRef.current = terminal;
    if (activeRef.current) terminal.focus();

    let ptyId: string | null = null;
    let disposed = false;
    let attached = false;
    let attaching: ReturnType<typeof setTimeout> | null = null;
    // Keystrokes arriving between open and spawn would otherwise be lost.
    let pending = "";
    // One write at a time, each once the last has landed: every keystroke is
    // an IPC call of its own, and on Windows typed text reached the session
    // out of order ("hello" as "helol"). What is typed meanwhile goes out
    // together in the next one, so a burst costs one round trip, not one per
    // key.
    let writing = false;
    let queued = "";
    const write = (id: string, data: string) => {
      queued += data;
      if (writing) return;
      const next = () => {
        const chunk = queued;
        queued = "";
        writing = true;
        void writePty(id, chunk)
          .catch(ignoreClosed)
          .finally(() => {
            writing = false;
            if (queued) next();
          });
      };
      next();
    };

    // Keys and pastes only: onData also carries what the terminal answers
    // on its own, such as focus and cursor reports. Only keys that can leave
    // a draft in an agent's prompt count: Enter sends it, and Escape, the
    // arrows and Ctrl or Cmd combinations write nothing into it.
    const keySub = terminal.onKey(({ domEvent }) => {
      if (pane && leavesDraft(domEvent)) noteTyped(pane);
    });
    const dataSub = terminal.onData((data) => {
      if (pane && data.startsWith("\x1b[200~")) noteTyped(pane);
      if (ptyId) {
        write(ptyId, data);
      } else {
        pending += data;
      }
    });
    // Driven by fit(), so this only fires when the geometry actually changed.
    const resizeSub = terminal.onResize(({ cols, rows }) => {
      if (ptyId) void resizePty(ptyId, cols, rows).catch(ignoreClosed);
    });
    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(container);

    // Deferred by a turn of the event loop on purpose. StrictMode runs this
    // effect twice — setup, cleanup, setup — and each spawn is a real tmux
    // client, so spawning immediately would have two clients fighting over
    // one pane: the second evicts the first with `attach -d`, and the loser
    // being reaped takes the session's only client down with it. The first
    // setup's cleanup lands before this timer fires, so only the surviving
    // mount ever attaches.
    const starting = setTimeout(() => {
      logLine(`terminal ${target}: starting in ${cwd ?? "home"} at ${terminal.cols}x${terminal.rows}`);
      void spawnPty(
        argsRef.current,
        cwd,
        { cols: terminal.cols, rows: terminal.rows },
        (event) => {
          // The channel outlives a teardown, and reporting a stale exit
          // would tear down whatever replaced this view.
          if (disposed) return;

          if (event.kind === "output") {
            terminal.write(decodeOutput(event.data));
            // A failed attach also prints something — an error message —
            // before exiting, so output alone is not proof the session is up.
            // Waiting a beat matters because the caller uses this to release a
            // terminal that is holding the session, and that cannot be taken
            // back.
            if (!attached && attaching === null) {
              attaching = setTimeout(() => {
                attaching = null;
                attached = true;
                logLine(`terminal ${target}: attached`);
                onAttachedRef.current?.();
              }, ATTACH_GRACE_MS);
            }
            return;
          }

          if (attaching !== null) {
            clearTimeout(attaching);
            attaching = null;
          }
          logLine(`terminal ${target}: exited with ${event.code}${attached ? "" : " before it attached"}`);
          onExitRef.current?.(event.code);
        },
        hostColors(currentTheme()),
      )
        .then((id) => {
          // A window closed while the PTY was starting still leaves a client
          // to reap.
          if (disposed) {
            void closePty(id);
            return;
          }
          ptyId = id;
          if (pending) {
            write(id, pending);
            pending = "";
          }
          // The window may have been resized while the PTY was starting.
          void resizePty(id, terminal.cols, terminal.rows).catch(ignoreClosed);
        })
        .catch((error: unknown) => {
          logLine(`terminal ${target}: could not start: ${String(error)}`);
          terminal.writeln(`roer: could not start the session: ${String(error)}`);
        });
    }, 0);

    // Files dropped from the desktop type their paths, as in a native
    // terminal; Claude Code attaches an image it finds that way. Only the
    // terminal on screen takes them, and only a drop over it.
    const showDropTarget = (on: boolean) => container.classList.toggle("terminal-drop-target", on);
    const stopFileDrag = onFileDrag((drag) => {
      // Unlistening is asynchronous: a drop can still arrive after cleanup.
      if (disposed) return;
      if (drag.type === "leave") return showDropTarget(false);
      const over = shownRef.current && isOver(container, drag.x, drag.y);
      if (drag.type === "over") return showDropTarget(over);
      showDropTarget(false);
      if (!over || drag.paths.length === 0) return;
      // Pasted, so a program that asked for bracketed paste gets it as one.
      terminal.paste(pathsAsTyped(drag.paths));
      terminal.focus();
    }).catch((error: unknown) => {
      logLine(`terminal ${target}: cannot take dropped files: ${String(error)}`);
      return () => {};
    });

    return () => {
      disposed = true;
      clearTimeout(pendingOpen);
      container.removeEventListener("mousedown", onPress, { capture: true });
      void stopFileDrag.then((stop) => stop());
      clearTimeout(starting);
      if (attaching !== null) clearTimeout(attaching);
      observer.disconnect();
      unfollowTheme();
      keySub.dispose();
      dataSub.dispose();
      resizeSub.dispose();
      paneSub.dispose();
      // Ends Roer's client only. The session behind it keeps running with no
      // client, which is what makes it reattachable from a terminal.
      if (ptyId) void closePty(ptyId);
      if (terminalRef.current === terminal) terminalRef.current = null;
      terminal.dispose();
    };
  }, [target, cwd]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  return <div ref={containerRef} data-testid="terminal" style={{ height: "100%" }} />;
}
