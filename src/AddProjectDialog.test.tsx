import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AddProjectDialog, repoName } from "./AddProjectDialog";

vi.mock("./lib/folderPicker", () => ({ pickFolder: vi.fn(async () => null) }));

const workspaces = [
  { id: "w1", name: "Default", projects: ["p1"] },
  { id: "w2", name: "Work", projects: [], folder: "/Users/test/work" },
];
const projects = [
  { id: "p1", name: "roer", path: "/Users/test/roer" },
  { id: "p2", name: "api", path: "/Users/test/api" },
];

function open(start = {}, onAdd = vi.fn()) {
  render(
    <AddProjectDialog
      start={{ workspaceId: "w1", ...start }}
      workspaces={workspaces}
      projects={projects}
      home="/Users/test"
      parentFor={(id) => (id === "w2" ? "/Users/test/work" : "/Users/test")}
      onAdd={onAdd}
      onClose={() => {}}
    />,
  );
  return onAdd;
}

describe("repoName", () => {
  it("names the folder as git clone would", () => {
    expect(repoName("https://github.com/owner/hello.git")).toBe("hello");
    expect(repoName("git@github.com:owner/hello.git")).toBe("hello");
    expect(repoName("https://example.com/owner/hello/")).toBe("hello");
    expect(repoName("git@host:hello")).toBe("hello");
  });
});

describe("AddProjectDialog", () => {
  it("clones into a folder named from the URL, beside the workspace's others", () => {
    const onAdd = open();
    fireEvent.change(screen.getByPlaceholderText("git@github.com:owner/repo.git"), {
      target: { value: "git@github.com:owner/hello.git" },
    });
    expect(screen.getByText("~/hello")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clone" }));

    expect(onAdd).toHaveBeenCalledWith({
      mode: "clone",
      url: "git@github.com:owner/hello.git",
      dest: "/Users/test/hello",
      workspaceId: "w1",
      session: true,
    });
  });

  it("refuses a quote, which could not be passed to the shell as one word", () => {
    const onAdd = open();
    fireEvent.change(screen.getByPlaceholderText("git@github.com:owner/repo.git"), {
      target: { value: "https://example.com/it's.git" },
    });

    expect(screen.getByText(/A quote in the URL or path/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone" })).toBeDisabled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("offers only the projects the workspace lacks, found by a search", () => {
    const onAdd = open({ mode: "known" });

    expect(screen.queryByRole("option", { name: /roer/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "zzz" } });
    expect(screen.getByText("None match.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("option", { name: /api/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onAdd).toHaveBeenCalledWith({ mode: "known", projectId: "p2", workspaceId: "w1", session: true });
  });
});
