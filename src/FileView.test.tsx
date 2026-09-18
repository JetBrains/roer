import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileView } from "./FileView";
import { fileRead, type FilesChanged, type FileText } from "./lib/files";

vi.mock("./lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/files")>()),
  fileRead: vi.fn(),
}));

const read = vi.mocked(fileRead);

const text = (over: Partial<FileText> = {}): FileText => ({
  text: "",
  lines: 0,
  truncated: false,
  binary: false,
  bytes: 0,
  ...over,
});

/**
 * A file of `count` numbered lines.
 *
 * One bare word per line, deliberately: the colourer splits `line 3` into a
 * word and a number, which are two elements, and then no query can match the
 * row by its text.
 */
const numbered = (count: number): FileText => {
  const body = Array.from({ length: count }, (_, i) => `row${i + 1}`).join(
    "\n",
  );
  return text({ text: `${body}\n`, lines: count, bytes: body.length + 1 });
};

const show = (props: Partial<Parameters<typeof FileView>[0]> = {}) =>
  render(
    <FileView
      root="/Users/test/project"
      path="src/App.tsx"
      active
      {...props}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(numbered(3));
});

describe("FileView", () => {
  it("reads the file the tab is about", async () => {
    show();
    await waitFor(() =>
      expect(read).toHaveBeenCalledWith("/Users/test/project", "src/App.tsx"),
    );
  });

  it("numbers the lines", async () => {
    show();
    await screen.findByText("row1");

    // Read off the attribute, because that is where the number is: the
    // gutter holds no text, so that a selection over the code cannot copy it.
    const gutter = document.querySelectorAll(".file-no");
    expect([...gutter].map((one) => one.getAttribute("data-no"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("shows the path it is reading", async () => {
    show({ path: "src/lib/tabs.ts" });
    expect(await screen.findByText("src/lib/tabs.ts")).toBeInTheDocument();
  });

  it("counts the lines in the header", async () => {
    show();
    expect(await screen.findByText("3 lines")).toBeInTheDocument();
  });

  it("does not count a trailing newline as a line of its own", async () => {
    read.mockResolvedValue(text({ text: "one\n", lines: 1, bytes: 4 }));
    show();
    await screen.findByText("one");
    expect(document.querySelectorAll(".file-no")).toHaveLength(1);
  });

  it("says when the file is empty", async () => {
    read.mockResolvedValue(text());
    show();
    expect(await screen.findByText("Empty file.")).toBeInTheDocument();
  });

  it("says when the file is binary rather than drawing it", async () => {
    read.mockResolvedValue(text({ binary: true, bytes: 900 }));
    show();
    expect(
      await screen.findByText("Binary file — nothing to show."),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".file-no")).toHaveLength(0);
  });

  it("says when only the start of the file was read", async () => {
    read.mockResolvedValue({
      ...numbered(3),
      truncated: true,
      bytes: 3 * 1024 * 1024,
    });
    show();
    expect(
      await screen.findByText(/Showing the first 1024 KB of a 3072 KB file/),
    ).toBeInTheDocument();
  });

  it("reports a file it could not read", async () => {
    read.mockRejectedValue(
      "could not read src/App.tsx: No such file or directory",
    );
    show();
    expect(
      await screen.findByText(/No such file or directory/),
    ).toBeInTheDocument();
  });

  it("refuses nothing the backend allowed, and says what it refused", async () => {
    read.mockRejectedValue("../etc/passwd is outside the repository");
    show();
    expect(
      await screen.findByText(/outside the repository/),
    ).toBeInTheDocument();
  });

  it("puts only the window in the DOM, not the whole file", async () => {
    read.mockResolvedValue(numbered(10_000));
    show();
    await screen.findByText("row1");

    // A screenful and its overscan, not ten thousand rows.
    const drawn = document.querySelectorAll(".file-line").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(200);
  });

  it("draws the lines a scroll brings into view", async () => {
    read.mockResolvedValue(numbered(10_000));
    show();
    await screen.findByText("row1");

    const body = document.querySelector(".file-body") as HTMLElement;
    // 18px a line, so this is somewhere around line 300.
    fireEvent.scroll(body, { target: { scrollTop: 5400 } });

    await waitFor(() => expect(screen.getByText("row301")).toBeInTheDocument());
    expect(screen.queryByText("row1")).not.toBeInTheDocument();
  });

  it("keeps the scrollbar honest about a file it is not all drawing", async () => {
    read.mockResolvedValue(numbered(1000));
    show();
    await screen.findByText("row1");

    // The spacers stand in for the rows that are not there, so the two of
    // them plus the drawn rows account for every line in the file.
    const body = document.querySelector(".file-body") as HTMLElement;
    const spacers = [...body.children].filter(
      (one) => !one.classList.contains("file-lines"),
    );
    const spaced = spacers.reduce(
      (sum, one) => sum + parseInt((one as HTMLElement).style.height),
      0,
    );
    const drawn = document.querySelectorAll(".file-line").length;

    expect(spaced / 18 + drawn).toBe(1000);
  });

  it("colours the code with the language's own grammar", async () => {
    read.mockResolvedValue(
      text({ text: "const x = 1;\n", lines: 1, bytes: 13 }),
    );
    show();

    // A grammar names the colour outright; the regex fallback sets a class and
    // lets CSS decide, so an inline colour is proof of which one ran.
    await waitFor(() =>
      expect(screen.getByText("const").getAttribute("style")).toMatch(/color/),
    );
  });

  it("falls back to the regex colourer where there is no grammar", async () => {
    read.mockResolvedValue(
      text({ text: "const x = 1;\n", lines: 1, bytes: 13 }),
    );
    show({ path: "notes.unknownext" });

    expect(await screen.findByText("const")).toHaveClass("t-keyword");
  });

  it("says when a file is too long to colour, and still draws it", async () => {
    read.mockResolvedValue(numbered(6000));
    show();
    await screen.findByText("row1");

    // Tokenising is not a drawing cost, so windowing does not make a
    // generated file affordable; it falls back to the regex painter.
    expect(screen.getByText(/too long to colour fully/)).toBeInTheDocument();
    expect(document.querySelectorAll(".file-line").length).toBeGreaterThan(0);
  });

  it("re-reads when the tab is pointed at another file", async () => {
    const { rerender } = show();
    await screen.findByText("row1");

    read.mockResolvedValue(text({ text: "other\n", lines: 1, bytes: 6 }));
    rerender(
      <FileView root="/Users/test/project" path="src/other.ts" active />,
    );

    expect(await screen.findByText("other")).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith(
      "/Users/test/project",
      "src/other.ts",
    );
  });

  it("re-reads the file whenever the tab comes to the front", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx" };
    const { rerender } = render(<FileView {...props} active={false} />);
    // Nothing to read while it is behind another tab.
    expect(read).not.toHaveBeenCalled();

    rerender(<FileView {...props} active />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    rerender(<FileView {...props} active={false} />);
    rerender(<FileView {...props} active />);

    // The session has been editing files the whole time it was hidden.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("keeps the old text on screen while it re-reads the same file", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx" };
    const { rerender } = render(<FileView {...props} active />);
    await screen.findByText("row1");

    rerender(<FileView {...props} active={false} />);
    rerender(<FileView {...props} active />);

    // No blink through "Reading…", which would take the scroll with it.
    expect(screen.queryByText("Reading…")).not.toBeInTheDocument();
    expect(screen.getByText("row1")).toBeInTheDocument();
  });

  it("scrolls to the line a path:42 query asked for", async () => {
    read.mockResolvedValue(numbered(1000));
    show({ line: 400 });

    // Opened around line 400, rather than at the top of the file.
    expect(await screen.findByText("row400")).toBeInTheDocument();
    expect(screen.queryByText("row1")).not.toBeInTheDocument();
  });

  it("re-reads when the watch names this file, and not when it names another", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx", active: true };
    const changed = (paths: string[], over: Partial<FilesChanged> = {}): FilesChanged => ({
      root: props.root,
      paths,
      broad: false,
      ...over,
    });

    const { rerender } = render(<FileView {...props} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    // The tab was never left: an agent wrote the file and the text follows.
    rerender(<FileView {...props} changed={changed(["src/App.tsx"])} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    // Its neighbours are not its business.
    rerender(<FileView {...props} changed={changed(["src/other.ts"])} />);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);

    // Nor is another repository, however this file is named there.
    rerender(
      <FileView
        {...props}
        changed={changed(["src/App.tsx"], { root: "/Users/test/other" })}
      />,
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);

    // A batch that gave up naming paths makes everything on screen suspect.
    rerender(<FileView {...props} changed={changed([], { broad: true })} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it("keeps the old text on screen while the watch's re-read is out", async () => {
    const props = { root: "/Users/test/project", path: "src/App.tsx", active: true };
    const { rerender } = render(<FileView {...props} />);
    await screen.findByText("row1");

    read.mockImplementation(() => new Promise(() => undefined));
    rerender(
      <FileView
        {...props}
        changed={{ root: props.root, paths: ["src/App.tsx"], broad: false }}
      />,
    );
    await act(async () => {});

    // No blink through "Reading…", which would take the scroll with it.
    expect(screen.queryByText("Reading…")).not.toBeInTheDocument();
    expect(screen.getByText("row1")).toBeInTheDocument();
  });
});
