/**
 * The one place every other module reaches into the backend, so it works
 * unchanged whether it is running inside Tauri's native webview or as a
 * plain page in a browser tab talking to `roer-server` over HTTP + a
 * WebSocket. Everywhere else imports `invoke`, `listen` and `Channel` from
 * here instead of `@tauri-apps/api/*`.
 *
 * Detection is `"__TAURI_INTERNALS__" in window`, the same check Tauri's own
 * API uses internally.
 */
import { invoke as tauriInvoke, Channel as TauriChannel } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export type { UnlistenFn };

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

type ServerMsg =
  | { kind: "Event"; event: string; payload: unknown }
  | { kind: "Channel"; id: string; payload: unknown };

const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
const channelListeners = new Map<string, (payload: unknown) => void>();
let socket: WebSocket | null = null;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/ws`;
}

/** One shared socket, reconnected lazily on next use if it drops. */
function ensureSocket(): void {
  if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) return;
  const ws = new WebSocket(wsUrl());
  ws.onmessage = (event) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.kind === "Event") {
      eventListeners.get(msg.event)?.forEach((fn) => fn(msg.payload));
    } else {
      channelListeners.get(msg.id)?.(msg.payload);
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
  };
  socket = ws;
}

/**
 * Stands in for Tauri's own `Channel`: constructed the same way
 * (`new Channel(); channel.onmessage = handler`), but under a browser tab it
 * is a tag on the server's shared WebSocket rather than an IPC callback.
 */
export class Channel<T = unknown> {
  /** Set only in Tauri; `invoke` passes this through to the real `invoke`. */
  readonly native?: TauriChannel<T>;
  /** Set only outside Tauri; `invoke` sends this id in the request body. */
  readonly id?: string;
  onmessage: (payload: T) => void = () => {};

  constructor() {
    if (inTauri()) {
      this.native = new TauriChannel<T>();
      this.native.onmessage = (payload) => this.onmessage(payload);
    } else {
      // Random rather than counted from zero: two tabs share the same
      // server-side bus, and a per-tab counter would let them both mint
      // "channel-1" and cross-wire each other's PTY output.
      this.id = crypto.randomUUID();
      ensureSocket();
      channelListeners.set(this.id, (payload) => this.onmessage(payload as T));
    }
  }
}

function toWireArgs(args: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    wire[key] = value instanceof Channel ? value.id : value;
  }
  return wire;
}

function toNativeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const native: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    native[key] = value instanceof Channel ? value.native : value;
  }
  return native;
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri()) {
    return tauriInvoke<T>(cmd, toNativeArgs(args));
  }
  ensureSocket();
  const res = await fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd, args: toWireArgs(args) }),
  });
  if (!res.ok) {
    // A non-2xx here is the auth middleware or a proxy, not `invoke`'s own
    // `{ ok: false, error }` shape — that only comes back on 200.
    throw new Error((await res.text().catch(() => "")) || `${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { ok: true; value: T } | { ok: false; error: string };
  if (!body.ok) throw new Error(body.error);
  return body.value;
}

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (inTauri()) {
    return tauriListen<T>(event, handler);
  }
  ensureSocket();
  const fn = (payload: unknown) => handler({ payload: payload as T });
  const set = eventListeners.get(event) ?? new Set();
  set.add(fn);
  eventListeners.set(event, set);
  return () => {
    eventListeners.get(event)?.delete(fn);
  };
}
