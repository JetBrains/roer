/**
 * `lib/backend` for a saved copy of a tab (`vite.copy.config.ts` puts this in
 * its place, so the `roer` SDK runs unchanged). While the copy is saved it
 * asks the saving view for everything, which runs only reads
 * (`protocol.ts`); in the saved file it plays back what those reads answered,
 * and anything else is "not in this saved copy".
 */
import { callKey, type Answer, type CopyBoot, type FromFrame, type ToFrame } from "./protocol";

export type UnlistenFn = () => void;

declare global {
  var __roerCopy: CopyBoot | undefined;
}

const boot = (): CopyBoot => {
  if (!globalThis.__roerCopy) throw new Error("not a saved copy's page");
  return globalThis.__roerCopy;
};

/** No terminal here: a Channel never hears anything. */
export class Channel<T = unknown> {
  onmessage: (payload: T) => void = () => {};
  dispose(): void {}
}

export const inDesktop = (): boolean => false;
export const isSavedCopy = (): boolean => true;

export type Reach = "up" | "unauthorized" | "down";
export const reachServer = async (): Promise<Reach> => "up";

/** What the tab asked for while it was saved, by command: what `copy.prepare` is handed. */
const seen = new Map<string, Array<{ args: Record<string, unknown>; value: unknown }>>();
export const seenCalls = (cmd: string) => seen.get(cmd) ?? [];

let nextId = 0;
const waiting = new Map<number, (answer: Answer) => void>();
/** Calls still out, and when the last one settled: what "the tab has drawn" is told by. */
let inFlight = 0;
let lastSettled = Date.now();

window.addEventListener("message", (event: MessageEvent<ToFrame>) => {
  if (event.source !== window.parent || event.data?.type !== "roer-copy:answer") return;
  waiting.get(event.data.id)?.(event.data.answer);
  waiting.delete(event.data.id);
});

/** To the saving view, which is the only one listening. */
export const tellParent = (message: FromFrame) => window.parent.postMessage(message, "*");

function ask(cmd: string, args: Record<string, unknown>): Promise<Answer> {
  const id = ++nextId;
  inFlight += 1;
  return new Promise<Answer>((resolve) => {
    waiting.set(id, resolve);
    tellParent({ type: "roer-copy:invoke", id, cmd, args });
  }).finally(() => {
    inFlight -= 1;
    lastSettled = Date.now();
  });
}

/** Settles once no call has been out for `quiet` ms, or after `limit` ms whatever happens. */
export function settled(quiet = 800, limit = 30000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const now = Date.now();
      if ((inFlight === 0 && now - lastSettled >= quiet) || now - started >= limit) resolve();
      else window.setTimeout(check, 100);
    };
    window.setTimeout(check, quiet);
  });
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const copy = boot();
  if (cmd === "extension_log") {
    console.info(`[${String(args.id)}] ${String(args.message)}`);
    return undefined as T;
  }
  if (copy.mode === "replay") {
    if (cmd === "shared_state_all") return (copy.shared ?? {}) as T;
    const answer = copy.answers?.[callKey(cmd, args)];
    if (!answer) throw new Error("not in this saved copy");
    if ("error" in answer) throw new Error(answer.error);
    return answer.value as T;
  }
  const answer = await ask(cmd, args);
  if ("error" in answer) throw new Error(answer.error);
  const calls = seen.get(cmd) ?? [];
  calls.push({ args, value: answer.value });
  seen.set(cmd, calls);
  return answer.value as T;
}

/** Nothing pushes events to a copy. */
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
