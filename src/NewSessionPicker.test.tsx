import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent, AgentList } from "./lib/agents";
import type { Place } from "./lib/checkouts";
import { gitBranches } from "./lib/git";
import { NewSessionPicker, type NewSessionPickerProps } from "./NewSessionPicker";

vi.mock("./lib/git", () => ({ gitBranches: vi.fn(async () => ["main", "release"]) }));

const roer = { id: "p1", name: "roer", path: "/work/roer" };
const site = { id: "p2", name: "site", path: "/work/site" };
const place = (cwd: string, project: typeof roer, branch: string, extra: Partial<Place> = {}): Place => ({
  key: cwd,
  cwd,
  project,
  label: `${project.name} · ${branch}`,
  linked: false,
  here: false,
  ...extra,
});
const places: Place[] = [
  place("/wt/roer/fix-login", roer, "fix-login", { linked: true, here: true }),
  place("/work/roer", roer, "main"),
  place("/work/site", site, "main"),
];

const agent = (id: string, name: string, cli: string): Agent => ({
  id,
  name,
  description: "",
  cli,
  command: "",
  model: "",
  effort: "",
  permissions: "",
  args: [],
  env: {},
  instructions: "",
  source: "builtin",
  path: "",
});
const cli = (id: string, installed = true) => ({
  id,
  label: id,
  bin: id,
  installed,
  models: [],
  efforts: [],
  permissions: [],
  instructions: false,
  resume: true,
});
const agents: AgentList = {
  agents: [agent("claude", "Claude Code", "claude"), agent("codex", "Codex", "codex"), agent("pi", "Pi", "pi")],
  clis: [cli("claude"), cli("codex"), cli("pi", false)],
  default: "claude",
  defaults: { user: null, project: null },
  project: false,
};

const made = (warnings: string[] = []) => ({
  worktree: {
    path: "/wt/roer/add-search",
    branch: "add-search",
    commit: "abc1234",
    main: false,
    base: null,
    locked: false,
    missing: false,
  },
  existingBranch: false,
  warnings,
});

function open(props: Partial<NewSessionPickerProps> = {}) {
  const onStart = vi.fn();
  const onCreateWorktree = vi.fn(async () => made());
  render(
    <NewSessionPicker
      places={places}
      agents={agents}
      start={{ step: "where" }}
      onCreateWorktree={onCreateWorktree}
      onStart={onStart}
      onClose={vi.fn()}
      {...props}
    />,
  );
  return { onStart, onCreateWorktree };
}

const box = () => screen.getByRole("combobox");
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(box(), { key });
const highlighted = () => screen.getByRole("option", { selected: true });

describe("the new session picker", () => {
  beforeEach(() => {
    vi.mocked(gitBranches).mockClear();
  });

  it("takes where it is and the default agent on Enter, Enter", () => {
    const { onStart } = open();
    expect(highlighted()).toHaveTextContent("roer · fix-login");
    expect(highlighted()).toHaveTextContent("here");
    press("Enter");
    expect(box()).toHaveAccessibleName("Start with");
    expect(highlighted()).toHaveTextContent("Claude Code");
    press("Enter");
    expect(onStart).toHaveBeenCalledWith("/wt/roer/fix-login", "claude");
  });

  it("finds a checkout and an agent by what is typed", () => {
    const { onStart } = open();
    type("site");
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toContain("site · main");
    press("Enter");
    type("codex");
    press("Enter");
    expect(onStart).toHaveBeenCalledWith("/work/site", "codex");
  });

  it("offers no agent whose CLI is missing, and a shell", () => {
    open({ start: { step: "with", cwd: "/work/roer" } });
    const names = screen.getAllByRole("option").map((row) => row.textContent);
    expect(names.join()).not.toContain("Pi");
    expect(names.at(-1)).toContain("Shell");
  });

  it("makes a new worktree named by what was typed, from the default branch", async () => {
    const { onStart, onCreateWorktree } = open();
    type("Add search");
    expect(highlighted()).toHaveTextContent("New worktree “Add search” in roer");
    press("Enter");
    expect(box()).toHaveAccessibleName("Branch from");
    await waitFor(() => expect(gitBranches).toHaveBeenCalledWith("/work/roer"));
    expect(highlighted()).toHaveTextContent("The default branch");
    press("Enter");
    press("Enter");
    expect(onCreateWorktree).toHaveBeenCalledWith("/work/roer", "Add search", "");
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("/wt/roer/add-search", "claude"));
  });

  it("branches a new worktree from a branch picked, or anything typed", async () => {
    const { onCreateWorktree } = open();
    type("Add search");
    press("ArrowDown"); // site's new worktree
    expect(highlighted()).toHaveTextContent("in site");
    press("Enter");
    await screen.findByRole("option", { name: /release/ });
    type("v1.2");
    expect(highlighted()).toHaveTextContent("v1.2");
    press("Enter");
    press("Enter");
    expect(onCreateWorktree).toHaveBeenCalledWith("/work/site", "Add search", "v1.2");
  });

  it("goes back a question on Backspace in an empty box", () => {
    open();
    press("Enter");
    expect(box()).toHaveAccessibleName("Start with");
    press("Backspace");
    expect(box()).toHaveAccessibleName("Where");
  });

  it("opened on the agent, starts where it was opened for, and does not go back past it", () => {
    const { onStart } = open({ start: { step: "with", cwd: "/work/site" } });
    expect(screen.getByRole("dialog")).toHaveTextContent("site · main");
    press("Backspace");
    expect(box()).toHaveAccessibleName("Start with");
    press("Enter");
    expect(onStart).toHaveBeenCalledWith("/work/site", "claude");
  });

  it("says what could not be copied, then starts anyway on Enter", async () => {
    const created = made(["could not copy .env: permission denied"]);
    const { onStart } = open({ onCreateWorktree: vi.fn(async () => created) });
    type("Add search");
    press("Enter");
    press("Enter");
    press("Enter");
    expect(await screen.findByText(/could not copy \.env/)).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
    expect(highlighted()).toHaveTextContent("Start anyway");
    press("Enter");
    expect(onStart).toHaveBeenCalledWith(created.worktree.path, "claude");
  });

  it("shows git's refusal and stays", async () => {
    const onClose = vi.fn();
    open({
      onClose,
      onCreateWorktree: vi.fn(async () => {
        throw "fix-login is already checked out in /work/roer.";
      }),
    });
    type("fix-login");
    // The checkout is there, so it comes first; the new worktree after it.
    press("ArrowDown");
    press("Enter");
    press("Enter");
    press("Enter");
    expect(await screen.findByText(/already checked out/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers a folder as a new project", () => {
    const onAttachNewProject = vi.fn();
    open({ onAttachNewProject });
    // Last in the list, a wrap up from the first.
    press("ArrowUp");
    expect(highlighted()).toHaveTextContent("Attach a folder as a project");
    press("Enter");
    expect(onAttachNewProject).toHaveBeenCalled();
  });
});
