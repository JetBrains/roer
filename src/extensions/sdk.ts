/**
 * The `roer` module an extension imports: the host's own code, handed over
 * at run time (see `host.ts`) so an extension's build carries none of it.
 * Bundled extensions import it the same way, through Vite's alias.
 *
 * What is here is what the bundled extensions are made of, so a fork of one
 * builds as it is. `docs/extensions.md` §2 lists it.
 */
export { defineExtension } from "./api";
export type { Activate, Extension, Roer, Session, TabOptions, ToolContext, ToolOptions } from "./api";
export { useActivateTab, useActive, useOpenFile, useSession } from "./context";

// The extension's own server.ts.
export { useCall, useRpc } from "./rpc";
export type { RpcState } from "./rpc";

// The backend, under either host (desktop app or `roer-server`).
export { Channel, invoke, listen } from "../lib/backend";
export type { UnlistenFn } from "../lib/backend";

// git, GitHub and files.
export * from "../lib/git";
export * from "../lib/github";
export { fileRead, filesGrep, filesList, filesSearch, onFilesChanged, baseName } from "../lib/files";
export type { FilesChanged, FileText, GrepHit, Hit, Hits } from "../lib/files";
export { resolveDir } from "../lib/session";

// What the built-in tabs draw with.
export { DiffPane } from "../DiffPane";
export type { DiffPaneProps } from "../DiffPane";
export { Spans } from "../CodeLine";
export { Markdown } from "../Markdown";
export { parseDiff, splitPatch, pairRows } from "../lib/diff";
export type { Diff, DiffLine, DiffNote, Hunk, NoteAction } from "../lib/diff";
export { buildTree, rows as treeRows, fileOrder } from "../lib/tree";
export type { TreeNode } from "../lib/tree";
export { highlight, highlightText, loadLang, paint, ready, toSpans } from "../lib/highlight";
export type { Span } from "../lib/highlight";
export { langFor } from "../lib/lang";
export type { Lang } from "../lib/lang";

// Keys.
export { useHotkey, shortcutLabel, isMac, isPrevCommit, isNextCommit } from "../lib/keys";
