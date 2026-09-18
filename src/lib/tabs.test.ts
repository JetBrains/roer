import { describe, expect, it } from "vitest";

import {
  activate,
  activeFile,
  closeTab,
  forRoot,
  MAX_FILE_TABS,
  noTabs,
  openFile,
  recent,
  tabId,
  tabName,
  type FileTab,
  type Tabs,
} from "./tabs";

const root = "/Users/test/project";
const file = (path: string, line?: number): FileTab => ({ kind: "file", root, path, line });

/** Open a run of files, oldest first. */
const opened = (...paths: string[]): Tabs =>
  paths.reduce((tabs, path) => openFile(tabs, file(path)), noTabs);

describe("tabId", () => {
  it("is the same for one file and different across repositories", () => {
    expect(tabId(file("src/App.tsx"))).toBe(tabId(file("src/App.tsx", 42)));
    expect(tabId({ kind: "file", root: "/other", path: "src/App.tsx" })).not.toBe(
      tabId(file("src/App.tsx")),
    );
    expect(tabId({ kind: "terminal" })).toBe("terminal");
  });
});

describe("tabName", () => {
  it("is the file name, which is all the strip has room for", () => {
    expect(tabName(file("src/lib/tabs.ts"))).toBe("tabs.ts");
  });
});

/** The strip, left to right. */
const strip = (tabs: Tabs) => tabs.files.map((file) => file.path);

describe("openFile", () => {
  it("opens a file and puts it on top", () => {
    const tabs = opened("a.ts");
    expect(strip(tabs)).toEqual(["a.ts"]);
    expect(activeFile(tabs)?.path).toBe("a.ts");
  });

  it("adds each file to the end of the strip and the front of the use order", () => {
    const tabs = opened("a.ts", "b.ts", "c.ts");
    expect(strip(tabs)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(recent(tabs)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("activates the tab a file already has rather than opening a second", () => {
    const tabs = openFile(opened("a.ts", "b.ts"), file("a.ts"));
    expect(strip(tabs)).toEqual(["a.ts", "b.ts"]);
    expect(recent(tabs)).toEqual(["a.ts", "b.ts"]);
    expect(tabs.active).toBe(tabId(file("a.ts")));
  });

  it("leaves a tab where it is in the strip when it is used again", () => {
    // The whole reason the two orders are kept apart: switching tabs must not
    // shuffle the strip under the pointer.
    const tabs = activate(opened("a.ts", "b.ts", "c.ts"), tabId(file("a.ts")));
    expect(strip(tabs)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(recent(tabs)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  it("takes a new line number to a file that is already open", () => {
    const tabs = openFile(opened("a.ts"), file("a.ts", 42));
    expect(activeFile(tabs)?.line).toBe(42);
    // Reopening without one leaves the line where it was, rather than
    // scrolling a tab back to the top for no reason.
    expect(activeFile(openFile(tabs, file("a.ts")))?.line).toBe(42);
  });

  it("evicts the least recently used past the cap", () => {
    const paths = Array.from({ length: MAX_FILE_TABS }, (_, i) => `f${i}.ts`);
    const full = opened(...paths);
    expect(full.files).toHaveLength(MAX_FILE_TABS);

    // `f0.ts` is the oldest, so it is the one that goes.
    const over = openFile(full, file("new.ts"));
    expect(over.files).toHaveLength(MAX_FILE_TABS);
    expect(strip(over)).not.toContain("f0.ts");
    expect(strip(over).at(-1)).toBe("new.ts");
    expect(recent(over)[0]).toBe("new.ts");
  });

  it("evicts by use rather than by age", () => {
    const paths = Array.from({ length: MAX_FILE_TABS }, (_, i) => `f${i}.ts`);
    // Touching the oldest makes the second-oldest the least recently used.
    const used = activate(opened(...paths), tabId(file("f0.ts")));
    const over = openFile(used, file("new.ts"));

    expect(strip(over)).toContain("f0.ts");
    expect(strip(over)).not.toContain("f1.ts");
  });
});

describe("closeTab", () => {
  it("leaves the neighbour on top", () => {
    // Strip is a, b, c and c is selected. Closing it leaves b, which is now
    // the last tab — the one where the pointer already is.
    const tabs = closeTab(opened("a.ts", "b.ts", "c.ts"), tabId(file("c.ts")));
    expect(strip(tabs)).toEqual(["a.ts", "b.ts"]);
    expect(activeFile(tabs)?.path).toBe("b.ts");
  });

  it("takes the tab to the right when one in the middle is closed", () => {
    const three = activate(opened("a.ts", "b.ts", "c.ts"), tabId(file("b.ts")));
    const tabs = closeTab(three, tabId(file("b.ts")));

    expect(strip(tabs)).toEqual(["a.ts", "c.ts"]);
    expect(activeFile(tabs)?.path).toBe("c.ts");
  });

  it("falls back to the terminal when the last file goes", () => {
    const tabs = closeTab(opened("a.ts"), tabId(file("a.ts")));
    expect(tabs.files).toEqual([]);
    expect(tabs.active).toBe("terminal");
  });

  it("leaves the selection alone when another tab is closed", () => {
    const tabs = closeTab(opened("a.ts", "b.ts"), tabId(file("a.ts")));
    expect(activeFile(tabs)?.path).toBe("b.ts");
  });

  it("cannot close the terminal or the changes view", () => {
    const tabs = activate(opened("a.ts"), "changes");
    expect(closeTab(tabs, "terminal")).toBe(tabs);
    expect(closeTab(tabs, "changes")).toBe(tabs);
  });
});

describe("activate", () => {
  it("brings a file to the front of the use order", () => {
    const tabs = activate(opened("a.ts", "b.ts"), tabId(file("a.ts")));
    expect(recent(tabs)).toEqual(["a.ts", "b.ts"]);
  });

  it("selects the terminal without closing anything", () => {
    const tabs = activate(opened("a.ts", "b.ts"), "terminal");
    expect(tabs.active).toBe("terminal");
    expect(strip(tabs)).toEqual(["a.ts", "b.ts"]);
    expect(activeFile(tabs)).toBeUndefined();
  });

  it("changes nothing when that tab is already on top", () => {
    const tabs = opened("a.ts");
    expect(activate(tabs, tabId(file("a.ts")))).toBe(tabs);
  });
});

describe("forRoot", () => {
  it("drops every file when there is no repository left", () => {
    const tabs = forRoot(opened("a.ts", "b.ts"), undefined);
    expect(tabs.files).toEqual([]);
    expect(tabs.active).toBe("terminal");
    // The use order cannot keep pointing at tabs that are gone.
    expect(tabs.used).toEqual(["terminal"]);
  });

  it("drops the files belonging to a repository that has been left", () => {
    const moved = openFile(opened("a.ts"), { kind: "file", root: "/other", path: "b.ts" });
    const tabs = forRoot(moved, "/other");

    expect(strip(tabs)).toEqual(["b.ts"]);
    expect(activeFile(tabs)?.path).toBe("b.ts");
  });

  it("falls back to the terminal when the selected file is dropped", () => {
    expect(forRoot(opened("a.ts"), "/other").active).toBe("terminal");
  });

  it("keeps a non-file selection when files are dropped", () => {
    const tabs = forRoot(activate(opened("a.ts"), "changes"), "/other");
    expect(tabs.active).toBe("changes");
    expect(tabs.files).toEqual([]);
  });

  it("changes nothing when every file is already from this repository", () => {
    const tabs = opened("a.ts", "b.ts");
    expect(forRoot(tabs, root)).toBe(tabs);
  });
});
