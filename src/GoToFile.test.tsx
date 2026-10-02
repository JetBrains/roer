import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoToFile, matchesQuery, merge, type SessionHit } from "./GoToFile";
import { filesSearch } from "./lib/files";
import type { Hit, Hits } from "./lib/files";

vi.mock("./lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/files")>()),
  filesSearch: vi.fn(),
}));

vi.mock("./lib/session", () => ({
  resolveDir: vi.fn(async () => "/Users/test/project"),
}));

const hit = (path: string, at: number[] = []): Hit => ({
  path,
  nameAt: new TextEncoder().encode(path.slice(0, path.lastIndexOf("/") + 1)).length,
  at,
  score: 10,
});

const answer = (hits: Hit[], over: Partial<Hits> = {}): Hits => ({
  root: "/Users/test/project",
  generation: 1,
  indexing: false,
  total: 3,
  matched: hits.length,
  line: null,
  hits,
  ...over,
});

const asked = vi.mocked(filesSearch);

/** Mount the popup and wait for the first answer to land. */
async function open(props: Partial<Parameters<typeof GoToFile>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  render(<GoToFile onOpen={onOpen} onClose={onClose} {...props} />);
  await waitFor(() => expect(asked).toHaveBeenCalled());
  return { onOpen, onClose };
}

/** Type into the search box and wait for the answer to that query. */
async function type(text: string) {
  const before = asked.mock.calls.length;
  fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
  await waitFor(() => expect(asked.mock.calls.length).toBeGreaterThan(before));
  await act(async () => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  asked.mockResolvedValue(answer([]));
});

describe("GoToFile", () => {
  it("searches the session's repository and lists what came back", async () => {
    asked.mockResolvedValue(
      answer([hit("src/App.tsx", [4, 5, 6]), hit("src/lib/git.ts"), hit("README.md")]),
    );
    await open();
    await type("app");

    expect(asked).toHaveBeenLastCalledWith("/Users/test/project", "app", 50);
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(3);
    // The name leads and the directory follows it, as IntelliJ shows them.
    expect(rows[0]).toHaveTextContent("App.tsxsrc/");
    expect(rows[0].querySelector("b")).toHaveTextContent("App");
  });

  it("takes the keyboard on the way in", async () => {
    await open();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("moves the selection with the arrows, wrapping at both ends", async () => {
    asked.mockResolvedValue(answer([hit("a.ts"), hit("b.ts"), hit("c.ts")]));
    await open();
    await type("ts");

    const selected = () => screen.getAllByRole("option").findIndex((row) => row.className === "hit on");
    const input = screen.getByRole("combobox");

    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toBe(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(0);
  });

  it("backs off its polling while a slow build runs", async () => {
    vi.useFakeTimers();
    try {
      // A build that is still running every time it is asked about — which is
      // what listing a big repo looks like from here.
      // A fresh object per ask, the way an answer off the IPC bridge arrives.
      asked.mockImplementation(async () => answer([], { indexing: true, total: 0 }));
      render(<GoToFile onOpen={vi.fn()} onClose={vi.fn()} />);
      // Enough for the repository to be resolved (a promise) and the first
      // ask to clear its debounce.
      // Twice over, and not once: resolving the repository is a promise, so
      // the debounce that follows it is only scheduled part-way through the
      // first advance, by which time the clock has already passed it.
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
      }
      expect(asked.mock.calls.length).toBeGreaterThan(0);
      const first = asked.mock.calls.length;

      // Five seconds of waiting for it. At a flat POLL_MS that is about
      // twenty-seven round trips; backing off should cost single figures.
      // Stepped for the same reason: each answer schedules the next ask
      // part-way through an advance, so the clock has to arrive at it.
      for (let i = 0; i < 100; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
      }

      const polls = asked.mock.calls.length - first;
      expect(polls).toBeLessThan(12);
      // Still polling, though — a build that finishes must be noticed.
      expect(polls).toBeGreaterThan(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the selection while a background build answers the same query again", async () => {
    const rows = [hit("src/App.tsx"), hit("src/lib/git.ts"), hit("src/lib/tabs.ts")];
    // What a stale snapshot answers: usable, with a rebuild running behind it.
    asked.mockResolvedValue(answer(rows, { indexing: true }));
    await open();
    await type("ts");

    const selected = () => screen.getAllByRole("option").findIndex((row) => row.className === "hit on");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(selected()).toBe(1);

    // The popup re-asks every POLL_MS until the build is done. Those answers
    // must not walk the selection back to the top under the user's fingers.
    const before = asked.mock.calls.length;
    await waitFor(() => expect(asked.mock.calls.length).toBeGreaterThan(before));
    await act(async () => undefined);

    expect(selected()).toBe(1);
  });

  it("follows the file, not the row, when a later answer reorders the list", async () => {
    const [app, git, tabs] = [hit("src/App.tsx"), hit("src/lib/git.ts"), hit("src/lib/tabs.ts")];
    asked.mockResolvedValue(answer([app, git, tabs], { indexing: true }));
    await open();
    await type("ts");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("title", "src/lib/git.ts");

    // A fuller index ranks the same three files differently, moving the file
    // the user aimed at from the second row to the last. The selection
    // belongs to the file, so it goes with it — row 1 would now be the wrong
    // file and row 0 would be the answer to a question nobody asked.
    asked.mockResolvedValue(answer([app, tabs, git], { indexing: false }));
    const before = asked.mock.calls.length;
    await waitFor(() => expect(asked.mock.calls.length).toBeGreaterThan(before));
    await act(async () => undefined);

    const rows = screen.getAllByRole("option");
    expect(rows[2]).toHaveAttribute("title", "src/lib/git.ts");
    expect(rows[2].className).toBe("hit on");
  });

  it("ignores a mouse move the pointer did not make", async () => {
    asked.mockResolvedValue(answer([hit("src/App.tsx"), hit("src/lib/git.ts")]));
    await open();
    await type("ts");

    const rows = screen.getAllByRole("option");
    // The pointer arrives over the first row and is then left alone.
    fireEvent.mouseMove(rows[0], { clientX: 100, clientY: 40 });
    expect(rows[0].className).toBe("hit on");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(rows[1].className).toBe("hit on");

    // Scrolling the list slid another row under the resting mouse, so the
    // browser reports a move at coordinates that have not changed.
    fireEvent.mouseMove(rows[0], { clientX: 100, clientY: 40 });
    expect(rows[1].className).toBe("hit on");

    // A move the hand really made still picks a row.
    fireEvent.mouseMove(rows[0], { clientX: 100, clientY: 41 });
    expect(rows[0].className).toBe("hit on");
  });

  it("opens the selected file on Enter and closes", async () => {
    asked.mockResolvedValue(answer([hit("src/App.tsx"), hit("src/lib/git.ts")]));
    const { onOpen, onClose } = await open();
    await type("ts");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onOpen).toHaveBeenCalledWith("/Users/test/project", "src/lib/git.ts", undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it("passes on the line number from a path:42 query", async () => {
    asked.mockResolvedValue(answer([hit("src/git.rs")], { line: 42 }));
    const { onOpen } = await open();
    await type("git.rs:42");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/Users/test/project", "src/git.rs", 42);
  });

  it("opens the row that was clicked", async () => {
    asked.mockResolvedValue(answer([hit("src/App.tsx")]));
    const { onOpen } = await open();
    await type("app");

    fireEvent.mouseDown(screen.getByRole("option"));
    expect(onOpen).toHaveBeenCalledWith("/Users/test/project", "src/App.tsx", undefined);
  });

  it("closes on Escape without opening anything", async () => {
    asked.mockResolvedValue(answer([hit("src/App.tsx")]));
    const { onOpen, onClose } = await open();
    await type("app");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says how many matched when it is showing only some of them", async () => {
    asked.mockResolvedValue(answer([hit("a.ts")], { matched: 1284 }));
    await open();
    await type("ts");
    expect(screen.getByText("1 of 1284 matches")).toBeInTheDocument();
  });

  it("says when nothing matched", async () => {
    await open();
    await type("zzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows the recently opened files before anything is typed", async () => {
    await open({
      recent: [
        { root: "/Users/test/project", path: "src/App.tsx" },
        { root: "/Users/test/project", path: "README.md" },
      ],
    });
    expect(screen.getByText("Recent files")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("asks again while a build is running, and stops when it finishes", async () => {
    asked.mockResolvedValue(answer([], { indexing: true, total: 0 }));
    await open();
    expect(screen.getByText("Indexing…")).toBeInTheDocument();

    asked.mockResolvedValue(answer([], { indexing: false, total: 900 }));
    await waitFor(() => expect(screen.getByText("900 files")).toBeInTheDocument());

    const settled = asked.mock.calls.length;
    await new Promise((done) => setTimeout(done, 250));
    expect(asked.mock.calls.length).toBe(settled);
  });

  it("reports a directory that is not in a repository", async () => {
    asked.mockRejectedValue("/tmp is not in a git repository.");
    await open();
    await waitFor(() =>
      expect(screen.getByText("/tmp is not in a git repository.")).toBeInTheDocument(),
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("drops an answer that lands under a newer query", async () => {
    // The first query resolves only after the second has been asked, so the
    // rows must be the second query's, not the first's.
    let release: ((hits: Hits) => void) | undefined;
    asked.mockImplementationOnce(
      () =>
        new Promise<Hits>((resolve) => {
          release = resolve;
        }),
    );
    asked.mockResolvedValue(answer([hit("second.ts")]));

    await open();
    await type("one");
    await type("two");
    await act(async () => {
      release?.(answer([hit("first.ts")]));
    });

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("second.ts");
  });
});

describe("GoToFile — a Workspace's Projects", () => {
  const api = "/Users/test/api";
  const roots = [
    { path: "/Users/test/project", name: "project" },
    { path: api, name: "API" },
  ];

  /** Each directory answers with its own hits, as its own root. */
  const byDir = (answers: Record<string, Hit[]>) =>
    asked.mockImplementation(async (dir: string) => answer(answers[dir] ?? [], { root: dir }));

  it("searches the session's repository and every Project, best first", async () => {
    byDir({
      "/Users/test/project": [{ ...hit("src/App.tsx"), score: 5 }],
      [api]: [{ ...hit("server/app.go"), score: 9 }],
    });
    await open({ roots });
    await type("app");

    expect(asked).toHaveBeenCalledWith("/Users/test/project", "app", 50);
    expect(asked).toHaveBeenCalledWith(api, "app", 50);
    // The session's repository is also a Project here, and is asked once.
    expect(asked.mock.calls.filter(([dir, query]) => dir === "/Users/test/project" && query === "app")).toHaveLength(1);
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual(["app.goserver/API", "App.tsxsrc/project"]);
    expect(screen.getByText("2 matches")).toBeInTheDocument();
  });

  it("opens a file in the repository it was found in", async () => {
    byDir({ [api]: [hit("server/app.go")] });
    const { onOpen } = await open({ roots });
    await type("app");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(api, "server/app.go", undefined);
  });

  it("names no repository when only one answered", async () => {
    asked.mockImplementation(async (dir: string) => {
      if (dir === api) throw new Error(`${api} is not in a git repository.`);
      return answer([hit("src/App.tsx")], { root: dir });
    });
    await open({ roots });
    await type("app");

    // A Project that is not a repository any more is left out, not an error.
    expect(screen.getByRole("option")).toHaveTextContent(/^App\.tsxsrc\/$/);
    expect(screen.queryByText(/not in a git repository/)).not.toBeInTheDocument();
  });
});

describe("merge", () => {
  it("counts a repository that answered twice once", () => {
    const one = answer([hit("a.ts")], { total: 3, matched: 1 });
    const found = merge([one, one], 50);
    expect(found.hits).toHaveLength(1);
    expect(found.total).toBe(3);
    expect(found.roots).toEqual(["/Users/test/project"]);
  });

  it("keeps the first repository first on a tie, and stops at the limit", () => {
    const found = merge(
      [answer([hit("a.ts"), hit("b.ts")]), answer([hit("c.ts")], { root: "/other" })],
      2,
    );
    expect(found.hits.map((one) => one.path)).toEqual(["a.ts", "b.ts"]);
    expect(found.matched).toBe(3);
  });
});

describe("GoToFile — sessions", () => {
  const session = (name: string, cwd: string, open = vi.fn()): SessionHit => ({
    key: name,
    name,
    detail: `claude · ${cwd}`,
    fields: [name, "claude", cwd],
    open,
  });

  it("matches every word, in any case and order", () => {
    const fields = ["Fixing the flaky test", "claude", "/work/roer"];
    expect(matchesQuery(fields, "")).toBe(true);
    expect(matchesQuery(fields, "ROER flaky")).toBe(true);
    expect(matchesQuery(fields, "roer dark")).toBe(false);
  });

  it("lists the matching sessions above the files, under their own headings", async () => {
    asked.mockResolvedValue(answer([hit("src/theme/dark.ts")]));
    await open({ sessions: [session("Add dark mode", "/work/roer"), session("Fix login", "/work/api")] });
    await type("dark");

    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Add dark modeclaude · /work/roer",
      "dark.tssrc/theme/",
    ]);
    expect(screen.getByText("1 session · 1 match")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
  });

  it("opens a session on Enter, and closes", async () => {
    const opened = vi.fn();
    const { onClose, onOpen } = await open({ sessions: [session("Add dark mode", "/work/roer", opened)] });
    await type("dark");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(opened).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("searches no files with nothing on the stage", async () => {
    render(
      <GoToFile noFiles sessions={[session("Add dark mode", "/work/roer")]} onOpen={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "login" } });
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });
});
