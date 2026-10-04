import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { closePty, decodeOutput, resizePty, spawnPty, writePty } from "./lib/pty";
import { logLine } from "./lib/log";
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
}

/**
 * Hosts the xterm.js instance and binds it to a PTY in the Rust backend.
 * The terminal owns its DOM node, so React only supplies the container.
 */
export function TerminalView({ args, cwd, onAttached, onPane, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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
    });
    const unfollowTheme = onThemeChange((theme) => {
      terminal.options.theme = terminalTheme(theme);
    });
    // Handled, so never drawn, whatever it says; only a pane id is passed on.
    const paneSub = terminal.parser.registerOscHandler(PANE_OSC, (data) => {
      // The session part as roer's is_pane_id holds it: no `:`, quotes or
      // control characters.
      const pane = /^pane=((?:=[^:'"`\x00-\x1f]+:\.)?%\d+)$/.exec(data)?.[1];
      logLine(`terminal ${target}: roer reported ${pane ?? `an unreadable pane (${data})`}`);
      if (pane) onPaneRef.current?.(pane);
      return true;
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

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

    const dataSub = terminal.onData((data) => {
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

    return () => {
      disposed = true;
      clearTimeout(starting);
      if (attaching !== null) clearTimeout(attaching);
      observer.disconnect();
      unfollowTheme();
      dataSub.dispose();
      resizeSub.dispose();
      paneSub.dispose();
      // Ends Roer's client only. The session behind it keeps running with no
      // client, which is what makes it reattachable from a terminal.
      if (ptyId) void closePty(ptyId);
      terminal.dispose();
    };
  }, [target, cwd]);

  return <div ref={containerRef} data-testid="terminal" style={{ height: "100%" }} />;
}
