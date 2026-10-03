/**
 * Extension tools for agents, the app's half. `roer mcp` lists what is
 * published here and drops each call as a record, which the backend hands
 * to this window as `roer://extension-call`. The window runs the tool and
 * answers with a receipt the waiting `roer mcp` reads. The same files as the
 * Generative UI panel's, so agents reach Roer one way.
 */
import { invoke, listen, type UnlistenFn } from "../lib/backend";
import { registry, type Registry, type ToolEntry } from "./registry";

export const EXTENSION_CALL_EVENT = "roer://extension-call";

/** One call, as `roer mcp` wrote it. */
export interface ExtensionCall {
  id: string;
  extension: string;
  tool: string;
  args?: Record<string, unknown>;
  pane?: string;
  cwd?: string;
}

/** What `roer mcp` lists: everything but the handler. */
const published = (tools: readonly ToolEntry[]) =>
  tools.map(({ extension, name, description, inputSchema }) => ({
    extension,
    name,
    description,
    inputSchema: inputSchema ?? { type: "object", properties: {} },
  }));

function isCall(value: unknown): value is ExtensionCall {
  const v = value as Partial<ExtensionCall> | null;
  return typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.extension === "string" && typeof v.tool === "string";
}

/** Runs `call` and answers it, unless another window got to it first. */
export async function answer(call: ExtensionCall, from: Registry = registry): Promise<void> {
  if (!(await invoke<boolean>("extension_call_claim", { id: call.id }))) return;
  const reply = (result: unknown, error: string | null) =>
    invoke("extension_call_reply", { id: call.id, result: result ?? null, error });
  const tool = from.tool(call.extension, call.tool);
  if (!tool) {
    await reply(null, `${call.extension} has no tool ${call.tool} loaded in Roer`);
    return;
  }
  try {
    const result = await tool.run(call.args ?? {}, { pane: call.pane, cwd: call.cwd });
    await reply(result === undefined ? "done" : result, null);
  } catch (cause) {
    await reply(null, cause instanceof Error ? cause.message : String(cause));
  }
}

/** Publishes the tools while they change, and answers calls to them. Returns the way to stop. */
export function serveTools(from: Registry = registry): () => void {
  let last = "";
  const publish = () => {
    const text = JSON.stringify(published(from.tools()));
    if (text === last) return;
    last = text;
    void invoke("extension_tools_publish", { tools: JSON.parse(text) }).catch(() => {
      // Not published: the next change to the registry tries again.
      if (last === text) last = "";
    });
  };
  publish();
  const unsubscribe = from.subscribe(publish);

  let unlisten: UnlistenFn | undefined;
  let stopped = false;
  void listen<unknown>(EXTENSION_CALL_EVENT, (event) => {
    if (isCall(event.payload)) void answer(event.payload, from);
  }).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });

  return () => {
    stopped = true;
    unsubscribe();
    unlisten?.();
  };
}
