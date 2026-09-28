import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { openUrl } from "../lib/github";
import { applyAll } from "./apply";
import { GenerativeSurface } from "./GenerativeSurface";
import { approvalGateMessages, SURFACE_ID } from "./fixtures";
import { A2UI_VERSION, type Component, type DataModel } from "./schema";

vi.mock("../lib/github", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

function draw(components: Component[], dataModel: DataModel = {}) {
  const state = applyAll([{ version: A2UI_VERSION, createSurface: { surfaceId: "s", components, dataModel } }]);
  const onSetValue = vi.fn();
  const onAction = vi.fn();
  render(
    <GenerativeSurface surface={state.surfaces.s} dataModel={state.dataModels.s} onSetValue={onSetValue} onAction={onAction} />,
  );
  return { onSetValue, onAction };
}

describe("GenerativeSurface", () => {
  it("waits for a root component", () => {
    draw([{ id: "other", component: "Divider" }] as Component[]);
    expect(screen.getByText(/Waiting for the surface's root/)).toBeInTheDocument();
  });

  it("binds text to the data model", () => {
    draw([{ id: "root", component: "Text", text: { path: "/user/name" } }], { user: { name: "Ada" } });
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("renders one template child per list element, with relative paths and @index", () => {
    draw(
      [
        { id: "root", component: "List", children: { componentId: "row", path: "/files" } },
        { id: "row", component: "Row", children: ["n", "name"] },
        { id: "n", component: "Text", text: { call: "@index", args: { offset: 1 } } },
        { id: "name", component: "Text", text: { path: "name" } },
      ],
      { files: [{ name: "a.ts" }, { name: "b.ts" }] },
    );
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("draws a progress bar only for templated cards that have progress", () => {
    draw(
      [
        { id: "root", component: "Column", children: { componentId: "run", path: "/runs" } },
        { id: "run", component: "StatusCard", title: { path: "title" }, progress: { path: "progress" } },
      ],
      { runs: [{ title: "build" }, { title: "deploy", progress: 64 }] },
    );
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute("aria-valuenow", "64");
  });

  it("colours CI statuses by meaning, failures included", () => {
    draw(
      [
        { id: "root", component: "Column", children: { componentId: "run", path: "/runs" } },
        { id: "run", component: "StatusCard", title: { path: "title" }, status: { path: "status" } },
      ],
      {
        runs: [
          { title: "a", status: "success" },
          { title: "b", status: "running" },
          { title: "c", status: "failed" },
        ],
      },
    );
    expect(screen.getByText("success")).toHaveClass("done");
    expect(screen.getByText("running")).toHaveClass("doing");
    expect(screen.getByText("failed")).toHaveClass("failed");
  });

  it("writes a templated checkbox back to its own element", () => {
    const { onSetValue } = draw(
      [
        { id: "root", component: "Column", children: { componentId: "box", path: "/files" } },
        { id: "box", component: "CheckBox", label: { path: "name" }, value: { path: "on" } },
      ],
      { files: [{ name: "a.ts", on: false }, { name: "b.ts", on: false }] },
    );
    fireEvent.click(screen.getByLabelText("b.ts"));
    expect(onSetValue).toHaveBeenCalledWith("/files/1/on", true);
  });

  it("resolves a button's event context at click time", () => {
    const { onAction } = draw(
      [
        { id: "root", component: "Button", child: "label", action: { event: { name: "go", context: { who: { path: "/user" }, n: 3 } } } },
        { id: "label", component: "Text", text: "Go" },
      ],
      { user: "ada" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onAction).toHaveBeenCalledWith({ name: "go", userMessage: undefined, context: { who: "ada", n: 3 } }, "root");
  });

  it("shows an unknown component as a placeholder", () => {
    draw([{ id: "root", component: "Script" } as unknown as Component]);
    expect(screen.getByText("[unsupported component: Script]")).toBeInTheDocument();
  });

  it("cuts a cycle instead of recursing", () => {
    draw([{ id: "root", component: "Card", child: "root" }]);
    expect(screen.getByText("[cyclic component: root]")).toBeInTheDocument();
  });

  it("passes accessibility through to ARIA", () => {
    draw([{ id: "root", component: "Text", text: "x", accessibility: { label: "Status", hidden: true } }]);
    const text = screen.getByText("x");
    expect(text).toHaveAttribute("aria-label", "Status");
    expect(text).toHaveAttribute("aria-hidden", "true");
  });

  it("shows a patch from the data model in the Changes tab's diff pane", async () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-const before = 1;",
      "+const after = 2;",
      "diff --git a/README.md b/README.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/README.md",
      "@@ -0,0 +1 @@",
      "+# Hello",
      "",
    ].join("\n");
    draw([{ id: "root", component: "DiffView", diff: { path: "/patch" }, title: "main...HEAD" }], { patch });
    const tree = screen.getByRole("list", { name: "Changed files" });
    expect(tree).toHaveTextContent("a.ts");
    expect(tree).toHaveTextContent("README.md");
    expect(screen.getByText("main...HEAD")).toBeInTheDocument();
    // The first file is selected, and its diff is read out of the patch.
    // Highlighting splits a line into tokens, so this reads the line whole.
    await waitFor(() => expect(document.querySelector(".line.add .text")).toHaveTextContent("const after = 2;"));
    expect(document.querySelector(".line.del .text")).toHaveTextContent("const before = 1;");
  });

  it.each(["unified", "split"] as const)("draws notes under the lines they are about (%s)", async (layout) => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-const before = 1;",
      "+const after = 2;",
      "",
    ].join("\n");
    const notes = [
      { path: "src/a.ts", text: "Renames the constant." },
      { path: "src/a.ts", line: 1, text: "Unchanged, kept for context." },
      { path: "src/a.ts", line: 2, side: "old", text: "The old name." },
      { path: "src/a.ts", line: 2, text: "The new name." },
      { path: "src/other.ts", line: 1, text: "Another file's note." },
      { line: 3, text: "No path, so dropped." },
    ];
    draw([{ id: "root", component: "DiffView", diff: { path: "/patch" }, notes: { path: "/notes" }, layout }], {
      patch,
      notes,
    });
    await waitFor(() => expect(document.querySelector(".line-note:not(.file)")).not.toBeNull());
    const texts = [...document.querySelectorAll(".line-note")].map((n) => n.textContent);
    expect(texts).toEqual(["Renames the constant.", "Unchanged, kept for context.", "The old name.", "The new name."]);
  });

  it("says so when the patch is empty", () => {
    draw([{ id: "root", component: "DiffView", diff: "", emptyText: "Nothing to review." }]);
    expect(screen.getByText("Nothing to review.")).toBeInTheDocument();
  });

  it("draws work items from different trackers as one board, and moves one with its footer", () => {
    const board = [
      { id: "root", component: "Row", children: ["todo", "done"] },
      { id: "todo", component: "List", children: { path: "/todo", componentId: "item" } },
      { id: "done", component: "List", children: { path: "/done", componentId: "item" } },
      {
        id: "item",
        component: "WorkItem",
        source: { path: "source" },
        key: { path: "key" },
        title: { path: "title" },
        status: { path: "status" },
        url: { path: "url" },
        labels: { path: "labels" },
        assignee: { path: "assignee" },
        footer: "move",
      },
      {
        id: "move",
        component: "Button",
        child: "moveLabel",
        action: { event: { name: "moveTask", context: { id: { path: "key" }, to: "done" } } },
      },
      { id: "moveLabel", component: "Text", text: "Done" },
    ] as Component[];
    const { onAction } = draw(board, {
      todo: [
        {
          source: "github",
          key: "#21",
          title: "Support configuring default agents",
          status: "open",
          url: "https://github.com/JetBrains/roer/issues/21",
          labels: ["enhancement"],
          assignee: "andrey-sokolov",
        },
        { source: "personal", key: "T-1", title: "Write the release notes", status: "todo" },
      ],
      done: [{ source: "youtrack", key: "RO-7", title: "Old ticket", status: "Fixed", url: "javascript:alert(1)" }],
    });

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("YouTrack")).toBeInTheDocument();
    expect(screen.getByText("enhancement")).toBeInTheDocument();
    expect(screen.getByText("andrey-sokolov")).toBeInTheDocument();
    expect(screen.getByText("Fixed")).toHaveClass("done");

    fireEvent.click(screen.getByRole("button", { name: "Support configuring default agents" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/JetBrains/roer/issues/21");
    // Anything but an https link is not offered as one.
    expect(screen.queryByRole("button", { name: "Old ticket" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Done" })[1]);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: "moveTask", context: { id: "T-1", to: "done" } }),
      "move",
    );
  });

  it("renders the approval-gate fixture", () => {
    const state = applyAll(approvalGateMessages);
    render(
      <GenerativeSurface
        surface={state.surfaces[SURFACE_ID]}
        dataModel={state.dataModels[SURFACE_ID]}
        onSetValue={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Apply 3 pending changes?")).toBeInTheDocument();
    expect(screen.getByLabelText(/watch\.rs/)).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply selected" })).toBeInTheDocument();
  });
});
