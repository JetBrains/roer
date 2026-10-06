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
    rpc: {
      /** Calls a method this extension's `server.ts` handles; rejects with what it threw. */
      call<T = unknown>(method: string, params?: unknown): Promise<T>;
    };
    tools: {
      /** Offers agents a tool through `roer mcp`, as `<extension id>__<name>`, for as long as the
       * extension is loaded. It runs here, in the app's window. The returned function takes it away. */
      register(tool: ToolOptions): () => void;
    };
  }

  /** Where an agent's tool call came from. */
  export interface ToolContext {
    /** The pane the calling agent runs in, when it runs in a Roer session. */
    pane?: string;
    /** The calling agent's working directory: `resolveDir(cwd, pane)` is where it is now. */
    cwd?: string;
  }

  export interface ToolOptions {
    /** Unique within the extension: letters, digits and `_`. */
    name: string;
    /** What it does and when to call it, written for the agent that will. */
    description: string;
    /** JSON Schema for the arguments. Default: an object with no properties. */
    inputSchema?: Record<string, unknown>;
    /** A string goes to the agent as it is, anything else as JSON; a throw is the agent's error. */
    run(args: Record<string, unknown>, context: ToolContext): unknown;
  }

  export interface TabOptions {
    /** Unique within the extension. */
    id: string;
    title: string;
    /** Takes no props: read the session with `useSession()`. */
    component: ComponentType;
    /** Where in the strip: Sessions is 0, Terminal 10, Changes 20. Default 100. */
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
    /** The agent running in it ("claude", "codex", …), once known; null when only a shell runs, which nothing
     * should type a prompt into. */
    agent?: string | null;
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
  /** Brings a tab to the top: "sessions", "terminal", "changes", or an extension's `ext:<id>/<tab>`. */
  export function useActivateTab(): (tabId: string) => void;

  // ---------------------------------------------------------------- server.ts

  export interface RpcState<T> {
    /** The last answer; kept while a reload is under way. */
    data: T | undefined;
    /** What the last call threw, or null. */
    error: string | null;
    loading: boolean;
    /** Calls again. */
    reload(): void;
  }
  /** Calls `method` on this extension's `server.ts` now, again whenever
   * `method` or `params` change, and on `reload()`. For reads. */
  export function useRpc<T = unknown>(method: string, params?: unknown): RpcState<T>;
  /** A function that calls this extension's `server.ts`. For actions. */
  export function useCall(): <T = unknown>(method: string, params?: unknown) => Promise<T>;

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

  /** Every repo-relative path in the repository holding `cwd`, sorted:
   * tracked and new files, .gitignore respected; 50,000 at most unless
   * `limit` says otherwise. Starts the worktree watch, like `filesGrep`. */
  export function filesList(cwd: string, limit?: number): Promise<string[]>;

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
    /** The rest of the message, after the subject; empty when there is none. */
    body: string;
  }

  /** The uncommitted changes of the repository holding `cwd`. */
  export function gitChanges(cwd: string): Promise<Changes>;
  export function gitRoot(cwd: string): Promise<string | null>;
  /** Where the session in `pane` is now, after any `cd`; `cwd` when that cannot be told. */
  export function resolveDir(cwd?: string, pane?: string): Promise<string>;
  export function gitCurrentBranch(cwd: string): Promise<string>;
  export function gitBranches(cwd: string): Promise<string[]>;
  /** A file's uncommitted diff, unified. */
  export function gitDiff(root: string, path: string, untracked: boolean): Promise<string>;
  export interface BranchDiff {
    root: string;
    /** What it is compared with, e.g. `origin/main`; empty when there is none, and then only what is uncommitted. */
    base: string;
    /** Commits the branch has over its base. */
    commits: number;
    diff: string;
    /** Why the patch is less than asked for: no commit in common with the base, so only what is uncommitted. */
    note?: string;
  }
  /** Everything the branch holding `cwd` has changed since it left `base` (default: the repository's default
   * branch), as one patch: its commits and what is not committed yet, untracked files included. With `head`, another
   * branch than the one checked out: its commits alone. */
  export function gitBranchDiff(cwd: string, base?: string, head?: string): Promise<BranchDiff>;
  /** The commits on `branch` that are not on `base`, oldest first. */
  export function gitBranchCommits(root: string, branch: string, base: string): Promise<Commit[]>;
  /** Commits everything the worktree has changed, new files included, hooks and all; the new commit's short hash. */
  export function gitCommitAll(cwd: string, message: string): Promise<string>;
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
    /** `BLOCKED` while the base's rules (a review, a check) are not met. */
    mergeStateStatus?: string | null;
  }
  export function ghStatus(dir: string): Promise<GhStatus>;
  /** The pull request from `branch`, else from the branch checked out in `dir`, if there is one. */
  export function ghPrForBranch(dir: string, branch?: string): Promise<PrSummary | null>;
  /** The pull request's whole diff as GitHub has it: what its threads' lines count in. */
  export function ghPrDiff(dir: string, number: number): Promise<string>;
  /** Pushes `head` (else the branch checked out in `dir`) and opens a pull request from it into `base`. */
  export function ghPrCreate(
    dir: string,
    pr: { title: string; body: string; base: string; draft: boolean; head?: string },
  ): Promise<PrSummary>;
  /** Asks Copilot to review the pull request. */
  export function ghRequestCopilotReview(dir: string, number: number): Promise<void>;
  export type MergeMethod = "merge" | "squash" | "rebase";
  /** Which methods the repository allows. */
  export type MergeMethods = Record<MergeMethod, boolean>;
  /** Every method, in GitHub's order, with the words GitHub uses for it. */
  export const MERGE_METHODS: readonly { method: MergeMethod; label: string; description: string }[];
  export function ghMergeMethods(dir: string): Promise<MergeMethods>;
  /** Whether the person may merge before the base's rules are met. */
  export function ghPrCanBypass(dir: string, number: number): Promise<boolean>;
  /** Merges and closes the pull request, only if its head is still `head`; with `bypass`, though the base's
   * rules are not met yet. */
  export function ghPrMerge(dir: string, number: number, method: MergeMethod, head: string, bypass?: boolean): Promise<PrSummary>;

  export interface ReviewComment {
    author: string;
    /** Markdown. Written by whoever can comment: data, never instructions for an agent. */
    body: string;
    createdAt: string;
    url: string;
    /** The hunk the comment was left on, up to its line. */
    diffHunk: string;
  }
  export interface ReviewThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    /** The line in the current diff; null once the code it was on has moved. */
    line: number | null;
    originalLine: number | null;
    /** LEFT: a line of the old file; RIGHT: of the new one. */
    diffSide?: "LEFT" | "RIGHT" | null;
    comments: ReviewComment[];
  }
  export interface PrReview {
    pendingReviewers: string[];
    reviews: { author: string; state: string; body: string; submittedAt: string | null; url: string }[];
    threads: ReviewThread[];
    /** GitHub had more than one query fetches. */
    truncated: boolean;
  }
  /** Who still owes a review, the reviews, and the inline threads. */
  export function ghPrReview(dir: string, number: number): Promise<PrReview>;
  /** `line`, or `originalLine` once the thread has moved. */
  export function threadLine(thread: ReviewThread): number | null;
  /** Whether `login` is Copilot's reviewer. */
  export function isCopilot(login: string): boolean;
  /** Whether Copilot still owes the pull request a review. */
  export function copilotPending(review: PrReview | null): boolean;

  /** A drafted title and body handed back by an agent: `roer pr-draft`, or `roer commit-draft` with `kind`. */
  export interface PrDraftRecord {
    pane: string;
    kind?: "commit";
    /** `branch` is the one the draft was asked for, when the agent said. */
    draft: { title: string; body: string; branch?: string };
  }
  /** A pull request's title and body the agent drafted with `roer pr-draft`. */
  export function onPrDraft(handler: (record: PrDraftRecord) => void): Promise<UnlistenFn>;
  /** A commit message the agent drafted with `roer commit-draft`: the subject as `title`. */
  export function onCommitDraft(handler: (record: PrDraftRecord) => void): Promise<UnlistenFn>;
  /** Asks the agent in `pane` to draft a pull request for `branch` against `base`, handed back with `roer pr-draft`. */
  export function draftPrPrompt(pane: string, branch: string, base: string): string;

  export type ThreadVerdict = { kind: "accept" } | { kind: "decline" } | { kind: "instruct"; text: string };
  /** A prompt for the session's agent: each thread, its conversation fenced as untrusted, and the person's decision on it. */
  export function reviewDecisionsPrompt(
    pr: PrSummary,
    decisions: readonly { thread: ReviewThread; verdict: ThreadVerdict }[],
  ): string;
  /** A prompt asking the agent to address `threads` as it sees fit. */
  export function fixThreadsPrompt(pr: PrSummary, threads: readonly ReviewThread[]): string;
  /** A comment's text fenced as data for an agent's prompt: a reviewer's, or another agent's. */
  export function untrustedComment(author: string, body: string, url?: string): string;
  /** What to tell the agent about fenced comments when the person's decision follows each one. */
  export const UNTRUSTED_DECIDED: string;
  /** Opens a URL in the person's browser. */
  export function openUrl(url: string): Promise<void>;
  /** Types `text` into a session's pane. */
  export function sendToSession(pane: string, text: string): Promise<void>;

  // ---------------------------------------------------------------- components

  /** Markdown as GitHub writes it, with raw HTML cleaned by GitHub's schema; links open in the browser.
   * It always has the `file-markdown` class, Roer's Markdown styles, which fill a pane with padding and a
   * scroll of their own; `className` goes beside it. Pass `md-inline` for text in a card, a row or a list item. */
  export function Markdown(props: { children: string; className?: string }): ReactNode;

  export interface DiffLine {
    kind: "context" | "add" | "del" | "meta";
    /** Without the leading marker. */
    text: string;
    /** On the left: context and removed lines. */
    oldNo?: number;
    /** On the right: context and added lines. */
    newNo?: number;
  }
  export interface Hunk {
    header: string;
    lines: DiffLine[];
    added: number;
    deleted: number;
  }
  /** One file's diff, parsed. */
  export function parseDiff(text: string): { hunks: Hunk[]; binary: boolean; truncated: boolean };
  /** A multi-file patch, one entry per file; `text` is that file's section, ready for `parseDiff`. */
  export function splitPatch(patch: string): {
    path: string;
    /** A, D, R, C or M. */
    status: string;
    renamedFrom?: string;
    added: number;
    deleted: number;
    binary: boolean;
    text: string;
  }[];

  /** Something said about a line of a diff, drawn under it. With an `author` it is a
   * comment card (markdown, replies); with an `id` and `noteActions` it can be answered. */
  export interface DiffNote {
    path: string;
    /** Counted in the new file, or the old one with `side: "old"`; without it the note heads the file. */
    line?: number;
    side?: "old" | "new";
    text: string;
    tone?: "info" | "warn" | "error";
    id?: string;
    author?: string;
    replies?: { author: string; text: string }[];
    /** A word on its corner, such as "outdated". */
    tag?: string;
    /** https only. */
    url?: string;
    /** Which `noteActions` value it was answered with; drawn in place of the buttons. */
    state?: string;
    /** The words that came with that answer. */
    answer?: string;
    /** This note's own answers, in place of the `noteActions` the diff offers every note. */
    actions?: NoteAction[];
  }

  export interface NoteAction {
    label: string;
    /** Reported as the answer, and what the note's `state` is once it is kept. */
    value: string;
    /** Asks for words first; this is the field's placeholder. */
    input?: string;
    primary?: boolean;
    /** What an answered note says in place of the buttons. Default: `label`. */
    done?: string;
  }

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
    notes?: DiffNote[];
    noteActions?: readonly import("roer/ui").NoteAction[];
    onNoteAnswer?: (answer: import("roer/ui").NoteAnswer) => void;
    /** Selects `path` at the change holding `line`, each time `seq` changes. */
    reveal?: { path: string; line: number; side?: "old" | "new"; seq: number };
  }): ReactNode;

  // ---------------------------------------------------------------- keys

  /** Runs `handler` for every keydown `match` accepts, before the terminal sees it.
   * Register only while `useActive()`, or the key is taken from every other tab. */
  export function useHotkey(match: (event: KeyboardEvent) => boolean, handler: (event: KeyboardEvent) => void): void;
  export function isMac(): boolean;
  /** Cmd+Left (Alt+Left off macOS): the previous commit. */
  export function isPrevCommit(event: KeyboardEvent): boolean;
  /** Cmd+Right (Alt+Right off macOS): the next commit. */
  export function isNextCommit(event: KeyboardEvent): boolean;
  /** How Roer's own shortcuts read on this platform, for tooltips and labels. */
  export const shortcutLabel: {
    newSession(): string;
    pickAgent(): string;
    agents(): string;
    goToFile(): string;
    tab(n: number): string;
    shortcuts(): string;
    nextWaiting(): string;
    previousSession(): string;
    prevCommit(): string;
    nextCommit(): string;
  };
}

// The module an extension's server.ts imports.
declare module "roer/server" {
  export interface ExecResult {
    /** The exit code. A non-zero one does not throw: check it. */
    code: number;
    stdout: string;
    stderr: string;
  }

  export interface Server {
    /** The extension's id, from its manifest. */
    readonly id: string;
    rpc: {
      /** Answers `method` for the frontend's `useRpc`, `useCall` and `roer.rpc.call`.
       * What `fn` returns, or resolves to, must be JSON; what it throws reaches the
       * caller as the error. The returned function stops answering. */
      handle(method: string, fn: (params: any) => unknown): () => void;
    };
    /** Runs a program to completion, without a shell: `argv[0]` is found on the
     * login shell's `PATH`. Every program the person can run is available. */
    exec(argv: string[], options?: { cwd?: string; input?: string; env?: Record<string, string> }): Promise<ExecResult>;
  }

  /** A server.ts's default export: `export default defineServer((roer) => { … })`.
   * Runs once each time the server starts. */
  export function defineServer(setup: (roer: Server) => void | Promise<void>): { readonly setup: (roer: Server) => void | Promise<void> };
}

// The Generative UI catalog as React components: build a tab from these and
// it looks and behaves like a surface an agent draws with `show_ui`. They
// carry Roer's own styles, in both themes; add your own CSS only for what
// the catalog has no component for.
declare module "roer/ui" {
  import type { CSSProperties, ReactNode } from "react";

  type Justify = "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly" | "stretch";
  type Align = "start" | "center" | "end" | "stretch";

  /** What every component passes to its root element. */
  export interface Common {
    "aria-label"?: string;
    "aria-description"?: string;
    "aria-live"?: "polite" | "assertive";
    "aria-hidden"?: boolean;
    style?: CSSProperties;
    /** Comment mode pins comments to the element carrying it. */
    "data-roer-id"?: string;
  }
  type WithChildren = Common & { children?: ReactNode };

  // layout
  export function Row(props: WithChildren & { justify?: Justify; align?: Align }): ReactNode;
  export function Column(props: WithChildren & { justify?: Justify; align?: Align }): ReactNode;
  export function List(props: WithChildren & { direction?: "vertical" | "horizontal"; align?: Align }): ReactNode;
  /** A bordered panel. Cards nest. */
  export function Card(props: WithChildren): ReactNode;
  /** The one layout that wraps, for tiles and cards whose count varies. `columns` wins over `minItemWidth` (px). */
  export function Grid(props: WithChildren & { columns?: number; minItemWidth?: number }): ReactNode;
  export function Divider(props: Common & { axis?: "horizontal" | "vertical" }): ReactNode;
  export function Tabs(props: Common & { tabs: { title: string; content: ReactNode }[] }): ReactNode;
  /** Opens `children` over the page when `trigger` is clicked. */
  export function Modal(props: WithChildren & { trigger: ReactNode }): ReactNode;
  export function Expandable(props: WithChildren & { title: string; defaultExpanded?: boolean }): ReactNode;
  export function Arrow(props: Common & { direction?: "horizontal" | "vertical"; label?: string }): ReactNode;

  // display
  export type TextVariant = "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body";
  /** `h1`–`h5` are headings: a tab's title is `h2`, a section's `h3`. `caption` is secondary text. */
  export function Text(props: WithChildren & { variant?: TextVariant }): ReactNode;
  export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
  /** A short label in a pill: a status letter, a count, a state. */
  export function Badge(props: WithChildren & { tone?: Tone }): ReactNode;
  /** In place of content: nothing to show (`empty`), still loading (`loading`, with a spinner), or failed (`error`).
   * Fills the room it is given and centres itself; `footer` holds a control, e.g. a Retry Button. */
  export function EmptyState(props: Common & {
    text: string;
    detail?: string;
    variant?: "empty" | "loading" | "error";
    footer?: ReactNode;
  }): ReactNode;
  export interface TableColumn {
    /** The field of each row this column shows. */
    key: string;
    title: string;
    /** `end` for numbers. */
    align?: "start" | "end";
    /** In px; columns without one share what is left. */
    width?: number;
    /** Monospaced, for times, ids, paths and codes. */
    mono?: boolean;
  }
  /** Rows of records under column headings, e.g. a log. A row whose `toneKey` field reads as failed or blocked
   * (`statusTone`) is coloured so. */
  export function Table(props: Common & {
    columns: TableColumn[];
    rows: Record<string, ReactNode>[];
    toneKey?: string;
    /** @default "Nothing to show." */
    emptyText?: string;
  }): ReactNode;
  export function Image(props: Common & {
    url: string;
    description?: string;
    fit?: "contain" | "cover" | "fill" | "none" | "scaleDown";
    variant?: "icon" | "avatar" | "smallFeature" | "mediumFeature" | "largeFeature" | "header";
  }): ReactNode;
  /** `{ svgPath }` is a 24×24 path; a string is shown as text (an emoji, a glyph). */
  export function Icon(props: Common & { name: string | { svgPath: string } }): ReactNode;
  export function Video(props: Common & { url: string; posterUrl?: string }): ReactNode;
  export function AudioPlayer(props: Common & { url: string; description?: string }): ReactNode;
  /** A KPI number for a dashboard, e.g. "12 running jobs". */
  export function StatTile(props: Common & {
    label: string;
    value: string | number;
    trend?: { delta: string | number; direction: "up" | "down" | "flat" };
    icon?: ReactNode;
  }): ReactNode;
  /** A ticket, a CI run, a deployment, a running job, a service: dense enough to mix kinds on one dashboard. */
  export function StatusCard(props: Common & {
    title: string;
    subtitle?: string;
    meta?: string;
    icon?: ReactNode;
    /** Coloured by meaning, see `statusTone`. */
    status?: string;
    /** 0-100, drawn as a slim bar. */
    progress?: number;
    /** An https link; the title opens it in the browser. */
    url?: string;
    /** Controls under it, e.g. a Row of Buttons. */
    footer?: ReactNode;
  }): ReactNode;
  /** One task from any tracker, drawn the same way whichever it is from. */
  export function WorkItem(props: Common & {
    title: string;
    /** `github`, `youtrack`, `notion`, `jira`, `personal`, or any other name. */
    source?: string;
    /** The tracker's own id: `#21`, `RO-12`. */
    itemKey?: string;
    status?: string;
    url?: string;
    assignee?: string;
    labels?: string[];
    meta?: string;
    footer?: ReactNode;
  }): ReactNode;
  /** A whole `git diff`, in Roer's diff viewer. */
  export function DiffView(props: Common & {
    patch: string;
    title: string;
    layout?: "unified" | "split";
    emptyText: string;
    notes?: import("roer").DiffNote[];
    /** The answers a note with an `id` offers, a button each; one with `input` asks for words first. */
    noteActions?: readonly NoteAction[];
    /** A note was answered; `action` "" takes an answer back. Set the note's `state` to keep it. */
    onNoteAnswer?: (answer: NoteAnswer) => void;
    /** Selects `path` at the change holding `line`, each time `seq` changes. */
    reveal?: { path: string; line: number; side?: "old" | "new"; seq: number };
    /** Lets the person comment on any line: each gets a + that opens a field under it. Draw what comes
     * back as one of `notes`. */
    onAddNote?: (note: NewNote) => void;
  }): ReactNode;

  /** A comment written on a line of a `DiffView`: a removed line counts in the old file, any other in the new. */
  export interface NewNote {
    path: string;
    line: number;
    side: "old" | "new";
    text: string;
  }

  export type NoteAction = import("roer").NoteAction;
  export interface NoteAnswer {
    note: import("roer").DiffNote;
    action: string;
    text?: string;
  }
  /** How a status is coloured: "done" (green: done, merged, passed, connected, healthy…), "doing" (running, in progress…),
   * "blocked" (waiting, on hold), "failed" (error, broken…), "todo" (anything else). */
  export function statusTone(status: string): "done" | "doing" | "blocked" | "failed" | "todo";

  // input
  export function Button(props: WithChildren & { variant?: "default" | "primary" | "borderless"; onClick?: () => void; disabled?: boolean }): ReactNode;
  /** Without a `label` it is a bare box, e.g. a filter over a list, named for screen readers by its
   * `aria-label` or else its placeholder. */
  export function TextField(props: Common & {
    label?: string;
    value: string;
    placeholder?: string;
    variant?: "shortText" | "longText" | "number" | "obscured" | "search";
    /** A number for the `number` variant, otherwise the text. */
    onChange: (value: string | number) => void;
    /** Enter in a one-line field. */
    onSubmit?: () => void;
  }): ReactNode;
  export function CheckBox(props: Common & { label: string; checked: boolean; onChange: (checked: boolean) => void }): ReactNode;
  export function Slider(props: Common & { label?: string; min?: number; max: number; steps?: number; value: number; onChange: (value: number) => void }): ReactNode;
  export function DateTimeInput(props: Common & {
    label?: string;
    value: string;
    enableDate?: boolean;
    enableTime?: boolean;
    min?: string;
    max?: string;
    onChange: (value: string) => void;
  }): ReactNode;
  /** Radio buttons, checkboxes (`multiple`), or chips (`chips`). `value` is the values picked. */
  export function ChoicePicker(props: Common & {
    label?: string;
    options: { label: string; value: string }[];
    value: string[];
    multiple?: boolean;
    chips?: boolean;
    filterable?: boolean;
    onChange: (value: string[]) => void;
  }): ReactNode;

  // catalog JSON

  /** One catalog component, as `show_ui` takes it (the `roer:catalog/1` resource documents every one). */
  export type Component = { id: string; component: string; [field: string]: unknown };
  export type DataModel = Record<string, unknown>;
  export interface ResolvedEvent {
    name: string;
    userMessage?: string;
    context: Record<string, unknown>;
  }
  /** Draws catalog JSON, the components and data model of a `show_ui` or `save_ui` surface, in the tab.
   * Its buttons' events come to `onAction` instead of an agent. */
  export function Surface(props: {
    components: Component[];
    data?: DataModel;
    onAction?: (event: ResolvedEvent) => void;
    onDataChange?: (data: DataModel) => void;
    onOpenFile?: (path: string) => void;
  }): ReactNode;
}
