/**
 * What the stage is showing, and the rules for opening and closing it.
 *
 * Pure functions over a plain value rather than state inside the component:
 * `App` carries the handoff state machine, and the tab rules are the part of
 * it that can be reasoned about — and tested — on their own.
 *
 * Two orders, deliberately. The strip keeps the order files were opened in, so
 * a tab stays where you last saw it; eviction goes by the order they were last
 * used. Folding those together would shuffle the strip on every switch.
 */
import { baseName } from "./files";

/**
 * How many files stay open at once. IntelliJ's default is ten and its rule is
 * to evict the least recently used; eight is the same rule, at the width the
 * stage has for a tab strip.
 */
export const MAX_FILE_TABS = 8;

export type StageTab =
  | { kind: "terminal" }
  | { kind: "changes" }
  | { kind: "file"; root: string; path: string; line?: number };

export type FileTab = StageTab & { kind: "file" };

/** Identity of a tab. Two tabs for one file in one repository is one tab. */
export const tabId = (tab: StageTab): string =>
  tab.kind === "file" ? `file:${tab.root}/${tab.path}` : tab.kind;

/** The tab's label: the file name, since the strip has no room for a path. */
export const tabName = (tab: FileTab): string => baseName(tab.path);

export interface Tabs {
  /** Open file tabs, in the order they were opened — the order of the strip. */
  files: readonly FileTab[];
  /** Every tab's id, most recently used first. Terminal and Changes are in
   * here too, so the MRU describes the whole stage. */
  used: readonly string[];
  /** The `tabId` of what is on top. Terminal and Changes are always open. */
  active: string;
}

export const noTabs: Tabs = { files: [], used: ["terminal"], active: "terminal" };

/** `id` first, and everything else in the order it already had. */
const touch = (used: readonly string[], id: string): readonly string[] => [
  id,
  ...used.filter((one) => one !== id),
];

export function activate(tabs: Tabs, id: string): Tabs {
  if (tabs.active === id) return tabs;
  return { ...tabs, used: touch(tabs.used, id), active: id };
}

/** The open file that has gone longest without being looked at. */
const stalest = (tabs: Tabs): FileTab | undefined => {
  for (let i = tabs.used.length - 1; i >= 0; i -= 1) {
    const file = tabs.files.find((one) => tabId(one) === tabs.used[i]);
    if (file) return file;
  }
  return tabs.files[0];
};

/**
 * Opens a file, or brings the tab that already has it to the front.
 *
 * Reopening a file activates its tab rather than adding a second one, which
 * is IntelliJ's behaviour and the only one that makes sense of a fixed cap.
 * A line number is taken from the new request, so `App.tsx:42` scrolls a tab
 * that was already open.
 */
export function openFile(tabs: Tabs, tab: FileTab): Tabs {
  const id = tabId(tab);
  if (tabs.files.some((file) => tabId(file) === id)) {
    return {
      // A fresh line number is the one thing a reopen carries over; without
      // one the tab keeps the line it was left at.
      files:
        tab.line === undefined
          ? tabs.files
          : tabs.files.map((file) => (tabId(file) === id ? { ...file, line: tab.line } : file)),
      used: touch(tabs.used, id),
      active: id,
    };
  }

  const evicted = tabs.files.length >= MAX_FILE_TABS ? stalest(tabs) : undefined;
  const evictedId = evicted && tabId(evicted);
  return {
    files: [...tabs.files.filter((file) => tabId(file) !== evictedId), tab],
    used: touch(
      tabs.used.filter((one) => one !== evictedId),
      id,
    ),
    active: id,
  };
}

/**
 * Closes a tab, leaving the neighbour on top.
 *
 * The neighbour rather than the next in the MRU: closing tabs one after
 * another should walk the strip you are looking at, not jump around it.
 * Terminal and Changes cannot be closed.
 */
export function closeTab(tabs: Tabs, id: string): Tabs {
  const at = tabs.files.findIndex((file) => tabId(file) === id);
  if (at < 0) return tabs;

  const files = tabs.files.filter((file) => tabId(file) !== id);
  const used = tabs.used.filter((one) => one !== id);
  if (tabs.active !== id) return { files, used, active: tabs.active };

  const neighbour = files[at] ?? files[at - 1];
  const active = neighbour ? tabId(neighbour) : "terminal";
  return { files, used: touch(used, active), active };
}

/**
 * Drops the file tabs that are not from `root`.
 *
 * A session that ends takes its files with it, and opening a file from
 * another repository means the session has moved: a tab holding a path
 * relative to a root nobody is in any more is a tab about nothing.
 */
export function forRoot(tabs: Tabs, root: string | undefined): Tabs {
  const files = root ? tabs.files.filter((file) => file.root === root) : [];
  if (files.length === tabs.files.length) return tabs;

  const kept = new Set(files.map(tabId));
  const used = tabs.used.filter((one) => !one.startsWith("file:") || kept.has(one));
  const active = kept.has(tabs.active) || !tabs.active.startsWith("file:")
    ? tabs.active
    : "terminal";
  return { files, used: touch(used, active), active };
}

/** The paths of the open files, most recently used first. */
export const recent = (tabs: Tabs): string[] =>
  tabs.used
    .map((id) => tabs.files.find((file) => tabId(file) === id))
    .filter((file): file is FileTab => Boolean(file))
    .map((file) => file.path);

/** The tab on top, if it is a file. */
export const activeFile = (tabs: Tabs): FileTab | undefined =>
  tabs.files.find((file) => tabId(file) === tabs.active);
