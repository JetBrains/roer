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
  /** What the program in the pane last titled it — Claude Code keeps a
   * summary of the task there. Empty when nothing has. */
  title?: string;
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
 * A past Claude Code conversation, resumable with `roer resume <id>`. Read
 * straight from Claude's own on-disk transcripts under `~/.claude` — roer
 * never writes there.
 */
export interface ClaudeSession {
  id: string;
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
): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("pty_spawn", {
    args: [...args],
    cwd,
    cols: size.cols,
    rows: size.rows,
    onEvent: channel,
  }).then((id) => {
    channels.set(id, channel);
    return id;
  });
}

export const writePty = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const resizePty = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { id, cols, rows });

export const closePty = (id: string): Promise<void> => {
  channels.get(id)?.dispose();
  channels.delete(id);
  return invoke("pty_close", { id });
};

export const listSessions = (): Promise<SessionInfo[]> => invoke("roer_sessions");

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
