/**
 * Typed bridge to the Rust PTY layer and the handoff watcher.
 *
 * Every session is `roer <args>`: mode 1 is `["shell"]`, mode 2 is
 * `["attach", pane]`. The frontend never names tmux.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PtyEvent =
  | { kind: "output"; data: string }
  | { kind: "exit"; code: number | null };

export interface SessionInfo {
  session: string;
  pane: string;
  attached: boolean;
  cwd: string;
  command: string;
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
  });
}

export const writePty = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const resizePty = (id: string, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { id, cols, rows });

export const closePty = (id: string): Promise<void> => invoke("pty_close", { id });

export const listSessions = (): Promise<SessionInfo[]> => invoke("roer_sessions");

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
