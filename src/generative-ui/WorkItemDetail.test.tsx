import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { openUrl } from "../lib/github";
import { applyAll } from "./apply";
import { GenerativeSurface } from "./GenerativeSurface";
import { A2UI_VERSION, type Component, type DataModel } from "./schema";
import { readComments, readDecisions, readFindings, readRequirements, readSources } from "./workItem";

vi.mock("../lib/github", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const patch = [
  "diff --git a/cli/src/main.rs b/cli/src/main.rs",
  "--- a/cli/src/main.rs",
  "+++ b/cli/src/main.rs",
  "@@ -1,2 +1,2 @@",
  " fn main() {",
  "-    old();",
  "+    new();",
  "diff --git a/cli/src/mcp.rs b/cli/src/mcp.rs",
  "--- a/cli/src/mcp.rs",
  "+++ b/cli/src/mcp.rs",
  "@@ -10,2 +10,3 @@",
  " let a = 1;",
  "+let b = 2;",
  " let c = 3;",
  "",
].join("\n");

const item = {
  key: "T-7",
  title: "Speak A2UI v1.0",
  status: "blocked",
  goal: "Move the panel to v1.0.",
  requirements: [
    { id: "r1", text: "Save one surface.json", met: true },
    { id: "r2", text: "Upgrade old bundles", met: false },
  ],
  sources: [
    { kind: "file", label: "spec", path: "docs/pluginsspec.md" },
    { kind: "ticket", label: "RO-142", url: "https://example.com/RO-142" },
  ],
  comments: [{ id: "c1", author: "Andrey", text: "Ready for review.", at: "2h ago" }],
  changes: [{ id: "c1", title: "Rust side", patch }],
  findings: [
    { id: "f1", severity: "warn", text: "Doc comment on the wrong test", at: { changeId: "c1", path: "cli/src/mcp.rs", line: 11 } },
    { id: "f2", severity: "info", text: "Already handled", state: "resolved" },
  ],
  decisions: [
    { id: "d1", question: "Keep legacy bundles readable?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] },
  ],
};

const detail: Component = {
  id: "root",
  component: "WorkItem",
  variant: "detail",
  key: { path: "/item/key" },
  title: { path: "/item/title" },
  status: { path: "/item/status" },
  goal: { path: "/item/goal" },
  requirements: { path: "/item/requirements" },
  sources: { path: "/item/sources" },
  comments: { path: "/item/comments" },
  changes: { path: "/item/changes" },
  findings: { path: "/item/findings" },
  decisions: { path: "/item/decisions" },
};

function draw(components: Component[], dataModel: DataModel) {
  const onAction = vi.fn();
  const onOpenFile = vi.fn();
  const surface = (model: DataModel) => {
    const state = applyAll([{ version: A2UI_VERSION, createSurface: { surfaceId: "s", components, dataModel: model } }]);
    return (
      <GenerativeSurface
        surface={state.surfaces.s}
        dataModel={state.dataModels.s}
        onSetValue={vi.fn()}
        onAction={onAction}
        onOpenFile={onOpenFile}
      />
    );
  };
  const view = render(surface(dataModel));
  return { onAction, onOpenFile, resend: (model: DataModel) => view.rerender(surface(model)) };
}

const section = (name: string) => screen.getByRole("region", { name });

describe("WorkItem detail", () => {
  it("lays the item out with what needs the user first", () => {
    draw([detail], { item });
    expect(screen.getByText("Speak A2UI v1.0")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toHaveClass("blocked");
    expect(screen.getByText("Move the panel to v1.0.")).toBeInTheDocument();
    const order = [...document.querySelectorAll(".gen-wi-section")].map((s) => s.getAttribute("aria-label"));
    expect(order).toEqual(["Needs you", "Requirements", "Sources", "Comments", "Changes"]);
    expect(within(section("Comments")).getByText("Andrey")).toBeInTheDocument();
    expect(within(section("Comments")).getByText("Ready for review.")).toBeInTheDocument();
    // One open decision and one open finding; the resolved one is only there to read back.
    expect(within(section("Needs you")).getByText("2")).toBeInTheDocument();
    expect(within(section("Requirements")).getByText("1 of 2")).toBeInTheDocument();
  });

  it("reports a ticked requirement and keeps it through a resend of the old item", () => {
    const { onAction, resend } = draw([detail], { item });
    const box = screen.getByRole("checkbox", { name: "Upgrade old bundles" });
    fireEvent.click(box);
    expect(onAction).toHaveBeenCalledWith(
      { name: "toggleRequirement", context: { workItem: "T-7", id: "r2", met: true } },
      "root",
    );
    expect(box).toBeChecked();

    resend({ item });
    expect(screen.getByRole("checkbox", { name: "Upgrade old bundles" })).toBeChecked();

    // Anything the agent says about it afterwards wins.
    const requirements = [item.requirements[0], { ...item.requirements[1], met: true }];
    resend({ item: { ...item, requirements } });
    resend({ item: { ...item, requirements: [item.requirements[0], { ...item.requirements[1], met: false }] } });
    expect(screen.getByRole("checkbox", { name: "Upgrade old bundles" })).not.toBeChecked();
  });

  it("settles a finding and draws an open one into its diff", async () => {
    const { onAction } = draw([detail], { item });
    // The only change is open by default, on its first file.
    await waitFor(() => expect(document.querySelector(".tree-row.selected .name")).toHaveTextContent("main.rs"));
    expect(document.querySelector(".line-note.warn")).toBeNull();

    // The finding's line takes the diff to its file, where it waits under the line.
    fireEvent.click(screen.getByRole("button", { name: "cli/src/mcp.rs:11" }));
    await waitFor(() => expect(document.querySelector(".tree-row.selected .name")).toHaveTextContent("mcp.rs"));
    await waitFor(() =>
      expect(document.querySelector(".line-note.warn")).toHaveTextContent("Doc comment on the wrong test"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onAction).toHaveBeenCalledWith(
      { name: "settleFinding", context: { workItem: "T-7", id: "f1", state: "resolved" } },
      "root",
    );
    expect(document.querySelector(".line-note.warn")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Reopen" })).toHaveLength(2);
  });

  it("answers a decision with an option or the user's own words", () => {
    const { onAction } = draw([detail], { item });
    const answer = screen.getByRole("button", { name: "Answer" });
    expect(answer).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Only for a release" } });
    fireEvent.click(answer);
    expect(onAction).toHaveBeenCalledWith(
      { name: "answerDecision", context: { workItem: "T-7", id: "d1", answer: "Only for a release" } },
      "root",
    );
    expect(screen.getByText("Answered: Only for a release")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByText("Answered: Yes")).toBeInTheDocument();
  });

  it("opens a file source in Roer and a link in the browser", () => {
    const { onOpenFile } = draw([detail], { item });
    fireEvent.click(screen.getByRole("button", { name: /spec/ }));
    expect(onOpenFile).toHaveBeenCalledWith("docs/pluginsspec.md");
    fireEvent.click(screen.getByRole("button", { name: /RO-142/ }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/RO-142");
  });

  it("leaves a card a card", () => {
    draw([{ ...detail, variant: undefined }], { item });
    expect(screen.getByText("Speak A2UI v1.0")).toBeInTheDocument();
    expect(screen.queryByText("Move the panel to v1.0.")).toBeNull();
    expect(document.querySelector(".gen-wi-detail")).toBeNull();
  });
});

describe("work item sections on their own", () => {
  it("draws Requirements, Findings, Decisions, Sources and Comments from their items", () => {
    const { onAction } = draw(
      [
        { id: "root", component: "Column", children: ["req", "fin", "dec", "src", "cmt"] },
        { id: "req", component: "Requirements", items: { path: "/item/requirements" } },
        { id: "fin", component: "Findings", items: { path: "/item/findings" } },
        { id: "dec", component: "Decisions", items: { path: "/item/decisions" } },
        { id: "src", component: "Sources", items: { path: "/item/sources" } },
        { id: "cmt", component: "Comments", items: { path: "/item/comments" } },
      ],
      { item },
    );
    expect(section("Requirements")).toBeInTheDocument();
    expect(section("Decisions")).toBeInTheDocument();
    expect(section("Sources")).toBeInTheDocument();
    expect(within(section("Comments")).getByText("Andrey")).toBeInTheDocument();
    // No diff beside it, so a finding's line is only named.
    expect(within(section("Findings")).getByText("cli/src/mcp.rs:11").tagName).toBe("SPAN");

    fireEvent.click(within(section("Findings")).getByRole("button", { name: "Dismiss" }));
    expect(onAction).toHaveBeenCalledWith({ name: "settleFinding", context: { id: "f1", state: "dismissed" } }, "fin");
  });
});

describe("reading work item parts off the wire", () => {
  it("keeps what is shaped right and drops the rest", () => {
    expect(readRequirements([{ id: "a", text: "x" }, { text: "no id" }, "nope"])).toEqual([
      { id: "a", text: "x", met: false },
    ]);
    expect(readFindings([{ id: "f", text: "t", severity: "loud", at: { path: "p", line: 1 } }])).toEqual([
      // An unknown severity is plain, and an `at` without its change is no place.
      { id: "f", text: "t", severity: "info", state: "open" },
    ]);
    expect(readDecisions([{ id: "d", question: "q", options: [{ value: "v" }, { label: "no value" }] }])).toEqual([
      { id: "d", question: "q", options: [{ value: "v", label: "v" }] },
    ]);
    expect(readSources([{ label: "a.md", path: "a.md" }, { kind: "slack" }])).toEqual([
      { kind: "file", label: "a.md", path: "a.md" },
    ]);
    expect(readComments([{ id: "c1", author: "A", text: "hi", at: "2h ago" }, { author: "no id" }])).toEqual([
      { id: "c1", author: "A", text: "hi", at: "2h ago" },
    ]);
    expect(readRequirements(undefined)).toEqual([]);
  });
});
