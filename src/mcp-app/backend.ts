/**
 * `lib/backend` for an extension opened in another app: the MCP App build
 * puts this in its place (`vite.mcp-app.config.ts`), so the `roer` SDK runs
 * unchanged. A command crosses to `roer mcp`, which runs what it can outside
 * Roer and says so for the rest; the few that mean "show this to the person"
 * go to the app instead.
 */
import { call, failed, openLink, say } from "./bridge";

export type UnlistenFn = () => void;

/** The extension this page draws, set once it is known: every command is run for it. */
let extension = "";
export const setExtension = (id: string) => void (extension = id);

/** No PTYs here: a Channel never hears anything. */
export class Channel<T = unknown> {
  onmessage: (payload: T) => void = () => {};
  dispose(): void {}
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (cmd) {
    case "open_url":
      return (await openLink(String(args.url))) as T;
    case "roer_send":
      return (await say(String(args.text))) as T;
    case "extension_log":
      // The extension's log is Roer's; the app's console is where it can go.
      console.info(`[${args.id}] ${args.message}`);
      return undefined as T;
  }
  try {
    const { value } = await call<{ value: T }>("invoke", { id: extension, command: cmd, args });
    return value;
  } catch (error) {
    const method = cmd === "extension_rpc" ? `server.ts's ${String(args.method)}` : cmd;
    failed(extension, `${method} failed: ${error instanceof Error ? error.message : String(error)}`, { logged: true });
    throw error;
  }
}

/** Nothing pushes events to this page yet. */
export async function listen<T>(_event: string, _handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  return () => {};
}

export type FileDrag =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; x: number; y: number; paths: string[] }
  | { type: "leave" };

export async function onFileDrag(_handler: (drag: FileDrag) => void): Promise<UnlistenFn> {
  return () => {};
}
