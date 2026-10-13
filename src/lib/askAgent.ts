/**
 * Asking a session's agent for something on the person's behalf: typed into
 * its prompt while it waits there with nothing of theirs in it, or else held
 * until it does. Requests made while it works no longer fail; they wait.
 *
 * The queue is the module's, not a component's, so that every place asking
 * for the same pane shares it and a held request goes out once.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

import { sendToSession } from "./github";
import { typedSince } from "./pty";

/** What the session's agent last said it is doing, from its own hooks. */
export type AgentState = "working" | "waiting" | "done" | "";

/** A request waiting for the agent, and what it asks in a few words, for
 * the screens that say it waits. */
export interface HeldRequest {
  text: string;
  label: string;
}

/** Held requests, oldest first, per pane. Replaced, never changed in place,
 * so a list handed to a render stays as it was. */
const held = new Map<string, readonly HeldRequest[]>();
const NONE: readonly HeldRequest[] = [];

const setHeld = (pane: string, list: readonly HeldRequest[]) => {
  if (list.length) held.set(pane, list);
  else held.delete(pane);
  changed();
};
/** Panes sent a request that have not started on it yet: the next one waits
 * for that turn, or both would be typed into the one prompt. */
const answering = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** For tests: forgets every held request. */
export function resetAskAgent(): void {
  held.clear();
  answering.clear();
  changed();
}

export interface AskAgent {
  /** Whether there is an agent here that says when it waits: without one,
   * nothing knows when a request can go. */
  canAsk: boolean;
  /** Whether a request made now goes at once. */
  ready: boolean;
  /** Requests held for this pane's agent, oldest first. */
  held: readonly HeldRequest[];
  /** Sends `text` now, or holds it until the agent waits; `label` says what it asks. */
  ask: (text: string, label?: string) => Promise<"sent" | "held">;
  /** Sends a held request at once, whatever the agent is doing: the person's call. */
  sendNow: (text: string) => Promise<void>;
  /** Drops a held request. */
  cancel: (text: string) => void;
}

export function useAskAgent(pane: string | undefined, agentState: AgentState | undefined): AskAgent {
  // When the agent's current turn started. Typing since then may be a draft
  // still sitting in its prompt, which a request would be typed onto and
  // submit.
  const turnStarted = useRef(0);
  useEffect(() => {
    if (agentState === "working") turnStarted.current = Date.now();
    if (pane && agentState !== "done" && answering.delete(pane)) changed();
  }, [pane, agentState]);

  const waiting = useSyncExternalStore(subscribe, () => (pane ? (held.get(pane) ?? NONE) : NONE));
  const pending = waiting.length;
  const ready = () =>
    !!pane && agentState === "done" && !answering.has(pane) && !typedSince(pane, turnStarted.current);

  const send = (target: string, text: string) => {
    answering.add(target);
    changed();
    return sendToSession(target, text).catch((e: unknown) => {
      answering.delete(target);
      changed();
      throw e;
    });
  };

  // A held request goes when the agent waits with an empty prompt. A draft
  // typed meanwhile can be sent or cleared at any moment, so that is looked
  // for every second rather than only when the agent's state moves.
  useEffect(() => {
    if (!pane || pending === 0 || agentState !== "done") return;
    const flush = () => {
      if (!ready()) return false;
      const [next, ...rest] = held.get(pane) ?? NONE;
      setHeld(pane, rest);
      if (next) void send(pane, next.text).catch((e: unknown) => console.error("roer: could not send a held request to the agent", e));
      return true;
    };
    if (flush()) return;
    const timer = setInterval(() => flush() && clearInterval(timer), 1000);
    return () => clearInterval(timer);
    // `ready` reads refs and module state; these are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, pending, agentState]);

  return {
    canAsk: !!pane && agentState !== undefined,
    ready: ready(),
    held: waiting,
    ask: async (text, label = text) => {
      if (!pane) throw new Error("no session to ask");
      if (pending === 0 && ready()) {
        await send(pane, text);
        return "sent";
      }
      // The same request twice, from a double click, goes once.
      const list = held.get(pane) ?? NONE;
      if (!list.some((request) => request.text === text)) setHeld(pane, [...list, { text, label }]);
      return "held";
    },
    sendNow: async (text) => {
      if (!pane) throw new Error("no session to ask");
      setHeld(pane, (held.get(pane) ?? NONE).filter((request) => request.text !== text));
      await send(pane, text);
    },
    cancel: (text) => {
      if (pane) setHeld(pane, (held.get(pane) ?? NONE).filter((request) => request.text !== text));
    },
  };
}
