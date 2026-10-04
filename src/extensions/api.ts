/**
 * What an extension's `app.tsx` is written against: `defineExtension`, the
 * `roer` object its activation gets, and the session its components read.
 * `docs/extensions.md` is the long form.
 */
import type { ComponentType } from "react";

import type { FilesChanged } from "../lib/files";

/** The session on the stage, as a tab sees it. */
export interface Session {
  pane?: string;
  /** Where the session was opened, before any `cd` inside it. */
  cwd?: string;
  /** The repository the session is in now, or null outside one. */
  root: string | null;
  branch: string | null;
  /** The agent it runs ("claude", "codex", …), once the session is listed; null when only a shell runs, which
   * nothing should type a prompt into. */
  agent?: string | null;
  /** The agent is working rather than waiting for the person. */
  busy: boolean;
  /** The latest batch the worktree watch reported. */
  changed: FilesChanged | null;
  /** Types `text` into the session's pane. */
  send(text: string): Promise<void>;
}

export interface TabOptions {
  /** Unique within the extension. */
  id: string;
  title: string;
  component: ComponentType;
  /** Where in the strip: Sessions is 0, Terminal 10, Changes 20. Default 100. */
  order?: number;
  /** Disabled with no session on the stage. Default true. */
  needsSession?: boolean;
  /** Keep the component mounted when the stage switches session, instead of
   * starting it over. Default false: state from one session never acts on another. */
  keepAcrossSessions?: boolean;
}

/** Where an agent's tool call came from. */
export interface ToolContext {
  /** The pane the calling agent runs in, when it runs in a Roer session. */
  pane?: string;
  /** The calling agent's working directory. */
  cwd?: string;
}

export interface ToolOptions {
  /** Unique within the extension; agents see it as `<extension id>__<name>`. */
  name: string;
  /** What it does and when to call it, written for the agent that will. */
  description: string;
  /** JSON Schema for its arguments. Default: an object with no properties. */
  inputSchema?: Record<string, unknown>;
  /** Answers the call: a string goes to the agent as it is, anything else as JSON. A throw is the agent's error. */
  run(args: Record<string, unknown>, context: ToolContext): unknown;
}

export interface Roer {
  /** The extension's id, from its manifest. */
  readonly id: string;
  stage: {
    /** Adds a tab to the strip. The returned function takes it away again. */
    registerTab(tab: TabOptions): () => void;
  };
  badge: {
    /** A count or a word on one of this extension's tabs; null clears it. */
    set(tab: string, text: string | null): void;
  };
  rpc: {
    /** Calls a method the extension's `server.ts` handles; rejects with what it threw. */
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
  };
  tools: {
    /** Offers agents a tool, through `roer mcp`, for as long as the extension is loaded.
     * The returned function takes it away again. */
    register(tool: ToolOptions): () => void;
  };
}

/** Runs once per load. A returned function runs on unload and before a reload. */
export type Activate = (roer: Roer) => void | (() => void);

export interface Extension {
  readonly activate: Activate;
}

/** An `app.tsx`'s default export. */
export function defineExtension(activate: Activate): Extension {
  return { activate };
}
