/**
 * Typed bridge to the Rust PTY layer and the handoff watcher.
 *
 * Every session is `roer <args>`: mode 1 is `["shell"]`, mode 2 is
 * `["attach", pane]`. The frontend never names tmux.
 */
import { Channel, invoke, listen, type UnlistenFn } from "./backend";

export type PtyEvent =
  | { kind: "output"; data: string }
  | { kind: "exit"; code: number | null };

export interface SessionInfo {
  id: string;
  session: string;
  pane: string;
  attached: boolean;
  cwd: string;
  command: string;
  /** The name of the agent roer started in the session, if it started one. */
  agent?: string;
  /** What the program in the pane last titled it — Claude Code keeps a
   * summary of the task there. Empty when nothing has. */
  title?: string;
  /** When the window last printed anything, in seconds since the epoch; 0
   * or missing when the shim cannot say. */
  activity?: number;
  /** Whether it rang the bell where nobody was looking. */
  bell?: boolean;
  /** What the agent's own hooks last said, while it runs: Claude Code
   * started by roer reports `working`, `waiting` (for a permission or an
   * answer) and `done` (a turn ended). Empty for anything without hooks. */
  state?: "working" | "waiting" | "done" | "";
  /** Its words for what it waits for, with `waiting`. */
  note?: string;
  /** When the session was last opened, in seconds since the epoch; 0 or
   * missing when it never was or the shim cannot say. */
  opened?: number;
}

/**
 * A session that no longer has a live tmux counterpart. Only ever metadata —
 * never a pane, attach state, or command line — so it can be reopened as a
 * fresh `new` in the same directory, not attached to.
 */
export interface PastSession {
  id: string;
  name: string;
  cwd: string;
  /** Seconds since the epoch. */
  createdAt: number;
  updatedAt: number;
  endedAt: number;
}

/**
 * A past agent conversation, resumable with `roer resume <id> --agent
 * <cli>`. Read straight from the CLI's own on-disk transcripts (Claude
 * Code's under `~/.claude`, Codex's under `~/.codex`) — roer never writes
 * there.
 */
export interface ClaudeSession {
  id: string;
  /** The CLI that wrote it: claude or codex. Absent means claude. */
  agent?: string;
  cwd: string;
  title: string;
  /** Seconds since the epoch (the transcript file's mtime). */
  updatedAt: number;
}

export interface RoerStatus {
  bin: string;
  available: boolean;
  home: string;
}

/**
 * A session the shim is handing over. It supplies the shim arguments to run,
 * so attach-versus-resume semantics stay in the shim rather than here.
 */
export interface Handoff {
  args: string[];
  cwd: string;
  label: string;
  /** Token to pass to {@link ackHandoff} once the session is on screen. */
  record: string;
}

/** Output arrives base64-encoded, because a PTY read can split a glyph. */
export function decodeOutput(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** By pty id, so `closePty` can dispose the channel that owns it — outside
 * Tauri, a live map entry retains the terminal/component state a closed
 * session no longer needs. */
const channels = new Map<string, Channel<PtyEvent>>();

export function spawnPty(
  args: readonly string[],
  cwd: string | undefined,
  size: { cols: number; rows: number },
  onEvent: (event: PtyEvent) => void,
  hostColors?: string,
): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("pty_spawn", {
    args: [...args],
    cwd,
    cols: size.cols,
    rows: size.rows,
    hostColors,
    onEvent: channel,
  }).then(
    (id) => {
      channels.set(id, channel);
      return id;
    },
    (error: unknown) => {
      channel.dispose();
      throw error;
    },
  );
}

export const writePty = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

/** When the person last typed or pasted into each pane's terminal. An agent
 * at its prompt may be holding a draft of theirs, which a prompt submitted
 * for them would be typed onto. */
const typedAt = new Map<string, number>();

export const noteTyped = (pane: string, at = Date.now()): void => {
  typedAt.set(pane, at);
};

/** Whether the person typed into `pane` after `time`. */
export const typedSince = (pane: string, time: number): boolean => (typedAt.get(pane) ?? -Infinity) > time;

export const resizePty = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { id, cols, rows });

export const closePty = (id: string): Promise<void> => {
  channels.get(id)?.dispose();
  channels.delete(id);
  return invoke("pty_close", { id });
};

/**
 * A pane title without the folder Codex appends to it: Codex titles its
 * terminal `<thread> | <project>`, and the project is already the heading
 * the row sits under. Only a trailing part that names one of the session's
 * own folders goes, so a title that merely has a `|` in it keeps it.
 */
export function withoutFolder(title: string | undefined, cwd: string): string | undefined {
  const at = title?.lastIndexOf(" | ") ?? -1;
  if (!title || at < 0) return title;
  const folder = title.slice(at + 3).trim();
  return folder && cwd.split(/[\\/]/).includes(folder) ? title.slice(0, at) : title;
}

export const listSessions = async (): Promise<SessionInfo[]> =>
  (await invoke<SessionInfo[]>("roer_sessions")).map((session) => ({
    ...session,
    title: withoutFolder(session.title, session.cwd),
  }));

/** Ends the session `pane` is in, and everything running in it. */
export const killSession = (pane: string): Promise<void> => invoke("roer_kill", { pane });

/**
 * Sessions that have ended, most recently ended first. Calling this is what
 * reconciles history against the live list, so it is only meaningful right
 * after (or alongside) a {@link listSessions} call.
 */
export const listPastSessions = (): Promise<PastSession[]> => invoke("roer_past_sessions");

/**
 * Past Claude conversations across the given cwds, most recently updated
 * first. Scoped to cwds roer already knows about — never a global scan.
 */
export const listClaudeSessions = (cwds: string[]): Promise<ClaudeSession[]> =>
  invoke("roer_claude_threads", { cwds });

export const roerStatus = (): Promise<RoerStatus> => invoke("roer_status");

/**
 * Handoffs written while Roer was down or starting up.
 *
 * The watcher cannot deliver those: it runs before the webview exists, and an
 * event with no listener is dropped. Since the shim starts Roer itself, this
 * is the ordinary path, not a corner case.
 */
export const pendingHandoffs = (): Promise<Handoff[]> => invoke("handoff_pending");

/**
 * Takes a handoff, before anything is attached. Rejects when the waiting
 * terminal has already given up, which is the point: without the claim a slow
 * attach would evict a terminal that had just been told nothing moved.
 * Resolves to the record token the other two calls take.
 */
export const claimHandoff = (record: string): Promise<string> =>
  invoke("handoff_claim", { record });

/**
 * Releases the terminal that is waiting on this handoff. Call it only once
 * the session is actually rendering — the shim treats it as permission to
 * let go.
 */
export const ackHandoff = (record: string): Promise<void> =>
  invoke("handoff_ack", { record });

/** Hands a claimed handoff back, so the terminal keeps the session. */
export const failHandoff = (record: string): Promise<void> =>
  invoke("handoff_fail", { record });

export const onHandoff = (handler: (handoff: Handoff) => void): Promise<UnlistenFn> =>
  listen<Handoff>("roer://handoff", (event) => handler(event.payload));
