// The `roer` module an extension's app.tsx imports: Roer's own code, handed
// over at run time. `roer ext new` writes this file into every new extension
// so an editor and `tsc` know the API; the build does not read it.

declare module "roer" {
  import type { ComponentType, ReactNode } from "react";

  // ---------------------------------------------------------------- extension

  /** An app.tsx's default export: `export default defineExtension((roer) => { … })`. */
  export function defineExtension(activate: Activate): Extension;

  /** Runs once per load. A returned function runs on unload and before a reload. */
  export type Activate = (roer: Roer) => void | (() => void);

  export interface Extension {
    readonly activate: Activate;
  }

  export interface Roer {
    /** The extension's id, from its manifest. */
    readonly id: string;
    stage: {
      /** Adds a tab to the stage's strip. The returned function takes it away again. */
      registerTab(tab: TabOptions): () => void;
    };
    badge: {
      /** A count or a word on one of this extension's tabs (by its `id`); null clears it. */
      set(tab: string, text: string | null): void;
    };
  }

  export interface TabOptions {
    /** Unique within the extension. */
    id: string;
    title: string;
    /** Takes no props: read the session with `useSession()`. */
    component: ComponentType;
    /** Where in the strip: Sessions is 0, Terminal 10, Changes 20, Pull Request 30. Default 100. */
    order?: number;
    /** Disabled while no session is on the stage. Default true. */
    needsSession?: boolean;
    /** Keep the component mounted when the stage switches session, instead of
     * starting it over. Default false. */
    keepAcrossSessions?: boolean;
  }

  /** The session on the stage. */
  export interface Session {
    pane?: string;
    /** Where the session was opened. */
    cwd?: string;
    /** The repository it is in now; null outside one, and briefly while it is looked up. */
    root: string | null;
    branch: string | null;
    /** The agent running in it ("claude", "codex", …), once known. */
    agent?: string;
    /** The agent is working rather than waiting. */
    busy: boolean;
    /** The latest batch of files the worktree watch saw change: re-read on a new one. */
    changed: FilesChanged | null;
    /** Types `text` into the session's pane, as if the person had. */
    send(text: string): Promise<void>;
  }

  /** The session on the stage; null while there is none. */
  export function useSession(): Session | null;
  /** Whether this tab is on top. Take the keyboard only while it is. */
  export function useActive(): boolean;
  /** Opens a file of the repository at `root` in a tab of its own. */
  export function useOpenFile(): (root: string, path: string, line?: number) => void;
  /** Brings a tab to the top: "sessions", "terminal", "changes", "pullRequest", or an extension's `ext:<id>/<tab>`. */
  export function useActivateTab(): (tabId: string) => void;

  // ---------------------------------------------------------------- backend

  /** Calls one of Roer's backend commands, in the desktop app or a browser tab alike. */
  export function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  export type UnlistenFn = () => void;
  export function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;

  // ---------------------------------------------------------------- files

  export interface FilesChanged {
    /** The worktree root. */
    root: string;
    /** Repo-relative paths, sorted. Empty when `broad` says it gave up naming them. */
    paths: string[];
    broad: boolean;
  }

  export interface GrepHit {
    /** Repo-relative. */
    path: string;
    line: number;
    /** The line, cut to 300 characters. */
    text: string;
  }

  /** The lines of the repository holding `cwd` that contain `pattern`, a plain
   * string, not a regex. Tracked and new files, .gitignore respected, binary
   * files skipped; 500 at most unless `limit` says otherwise. */
  export function filesGrep(cwd: string, pattern: string, limit?: number): Promise<GrepHit[]>;

  export interface FileText {
    text: string;
    lines: number;
    truncated: boolean;
    binary: boolean;
    bytes: number;
  }
  /** A file of the repository at `root`, by its repo-relative path. */
  export function fileRead(root: string, path: string): Promise<FileText>;

  export function baseName(path: string): string;

  // ---------------------------------------------------------------- git

  export interface FileChange {
    path: string;
    /** Index status letter; "." when the index matches HEAD. */
    staged: string;
    /** Worktree status letter; "." when clean, "?" when untracked. */
    unstaged: string;
    added: number;
    deleted: number;
    renamedFrom?: string | null;
    binary: boolean;
    counted: boolean;
  }
  export interface Changes {
    root: string;
    branch: string;
    commit: string;
    files: FileChange[];
  }
  export interface Commit {
    hash: string;
    short: string;
    author: string;
    /** Unix seconds. */
    date: number;
    subject: string;
  }

  /** The uncommitted changes of the repository holding `cwd`. */
  export function gitChanges(cwd: string): Promise<Changes>;
  export function gitRoot(cwd: string): Promise<string | null>;
  export function gitCurrentBranch(cwd: string): Promise<string>;
  export function gitBranches(cwd: string): Promise<string[]>;
  /** A file's uncommitted diff, unified. */
  export function gitDiff(root: string, path: string, untracked: boolean): Promise<string>;
  /** The commits on `branch` that are not on `base`, oldest first. */
  export function gitBranchCommits(root: string, branch: string, base: string): Promise<Commit[]>;
  export function gitCommitFiles(root: string, commit: string): Promise<FileChange[]>;
  export function gitCommitDiff(root: string, commit: string, path: string): Promise<string>;
  export function isUntracked(file: FileChange): boolean;
  /** One letter for a change: M, A, D, R, ? … */
  export function statusLetter(file: FileChange): string;

  // ---------------------------------------------------------------- GitHub (through `gh`)

  export interface GhStatus {
    installed: boolean;
    authenticated: boolean;
    /** owner/name, when the directory is in a GitHub repository. */
    repo: string | null;
    message: string | null;
  }
  export interface PrSummary {
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    reviewDecision: string | null;
  }
  export function ghStatus(dir: string): Promise<GhStatus>;
  /** The pull request for the branch checked out in `dir`, if there is one. */
  export function ghPrForBranch(dir: string): Promise<PrSummary | null>;
  /** Opens a URL in the person's browser. */
  export function openUrl(url: string): Promise<void>;
  /** Types `text` into a session's pane. */
  export function sendToSession(pane: string, text: string): Promise<void>;

  // ---------------------------------------------------------------- components

  /** Markdown as GitHub writes it; links open in the browser. */
  export function Markdown(props: { children: string; className?: string }): ReactNode;

  /** Roer's diff viewer: a file tree beside the selected file's diff, with keyboard navigation. */
  export function DiffPane(props: {
    /** null while the list is loading. */
    files: FileChange[] | null;
    error: string | null;
    active: boolean;
    loadDiff: (path: string, untracked: boolean) => Promise<string>;
    /** A new value clears the selection: another commit, another repository. */
    resetKey: string | number;
    /** A new value re-reads the selected file's diff. */
    refreshToken?: string | number;
    title: ReactNode;
    emptyMessage: ReactNode;
    headerExtra?: ReactNode;
    defaultLayout?: "unified" | "split";
  }): ReactNode;

  // ---------------------------------------------------------------- keys

  /** Runs `handler` for every keydown `match` accepts, before the terminal sees it.
   * Register only while `useActive()`, or the key is taken from every other tab. */
  export function useHotkey(match: (event: KeyboardEvent) => boolean, handler: (event: KeyboardEvent) => void): void;
  export function isMac(): boolean;
}
