/**
 * The MCP Apps side of an extension opened in another app (the Claude app,
 * the Codex app): JSON-RPC 2.0 over `postMessage` with the app that draws
 * this page in its iframe. Everything Roer itself does goes through one of
 * `roer mcp`'s tools, `roer_ext_call`, which the app passes on.
 */

export interface HostContext {
  theme?: "light" | "dark";
  displayMode?: "inline" | "fullscreen" | "pip";
  availableDisplayModes?: string[];
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number };
}

export interface Opened {
  hostName: string;
  context: HostContext;
}

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let nextId = 1;
const pending = new Map<number, Waiter>();
const handlers = new Map<string, (params: any) => void>();

const send = (message: object) => window.parent.postMessage(message, "*");

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
}

export const notify = (method: string, params?: unknown) => send({ jsonrpc: "2.0", method, params });

/** Hears a notification from the app; the last handler for a method wins. */
export const on = (method: string, handler: (params: any) => void) => void handlers.set(method, handler);

window.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id != null && !m.method) {
    const waiter = pending.get(m.id);
    if (!waiter) return;
    pending.delete(m.id);
    if (m.error) waiter.reject(new Error(m.error.message ?? String(m.error)));
    else waiter.resolve(m.result);
    return;
  }
  if (m.id != null) {
    // A request from the app: teardown and ping only want an answer.
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  handlers.get(m.method)?.(m.params);
});

/** Says hello to the app; what it answers is who it is and how it draws us. */
export async function open(): Promise<Opened> {
  const init = await request<{ hostInfo?: { name?: string }; hostContext?: HostContext }>("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "roer", version: "1" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  });
  notify("ui/notifications/initialized", {});
  return { hostName: init?.hostInfo?.name ?? "the app", context: init?.hostContext ?? {} };
}

/** Calls `roer_ext_call` on `roer mcp`: its text is JSON, or the error it failed with. */
export async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await request<{ content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }>(
    "tools/call",
    { name: "roer_ext_call", arguments: { method, ...params } },
  );
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (result?.isError) throw new Error(text || `${method} failed`);
  if (result?.structuredContent !== undefined) return result.structuredContent as T;
  return (text ? JSON.parse(text) : null) as T;
}

/** Puts `text` in the conversation as the person's next message. */
export const say = (text: string) => request<void>("ui/message", { role: "user", content: [{ type: "text", text }] });

export const openLink = (url: string) => request<void>("ui/open-link", { url });

export const resized = (width: number, height: number) => notify("ui/notifications/size-changed", { width, height });

/**
 * Tells the agent what went wrong in the tab, which it otherwise never sees: as the tab's context in the
 * conversation, where the host keeps the latest, and in the extension's own log, which `extension_logs` reads.
 */
export function failed(extension: string, message: string, options: { logged?: boolean } = {}) {
  void request("ui/update-model-context", {
    content: [
      {
        type: "text",
        text: `The ${extension} extension's tab, open in this conversation, shows an error: ${message}\nIts whole log is in extension_logs (id ${extension}); fix it with extension_write, then open it again.`,
      },
    ],
  }).catch(() => undefined);
  // A failed call to `roer mcp` is in the log already: it wrote it there.
  if (!options.logged) void call("report", { id: extension, message }).catch(() => undefined);
}
