import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { gitChanges } from "../../lib/git";
import type { Scope } from "../api";
import { registry } from "../registry";
import { WorkspaceSections } from "../WorkspaceSections";
import repositories from "./app";

vi.mock("../../lib/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git")>()),
  gitChanges: vi.fn(),
}));

const work: Scope = {
  kind: "workspace",
  id: "w1",
  name: "work",
  projects: [
    { name: "api", path: "/work/api" },
    { name: "web", path: "/work/web" },
    { name: "old", path: "/work/old" },
  ],
  folder: "/work",
};

describe("the Repositories section", () => {
  afterEach(() => registry.unload("repositories"));

  it("says each project's branch and what is not committed, and which it could not read", async () => {
    vi.mocked(gitChanges).mockImplementation(async (path) => {
      if (path === "/work/old") throw new Error("not a git repository");
      return path === "/work/api"
        ? {
            root: path,
            branch: "fix-login",
            commit: "abc1234",
            files: [
              { path: "a.ts", staged: ".", unstaged: "M", added: 3, deleted: 1, binary: false, counted: true },
              { path: "b.ts", staged: ".", unstaged: "?", added: 10, deleted: 0, binary: false, counted: true },
            ],
          }
        : { root: path, branch: "main", commit: "def5678", files: [] };
    });
    registry.load("repositories", repositories, { bundled: true });
    render(<WorkspaceSections scope={work} session={null} active openFile={() => undefined} activateTab={() => undefined} />);

    const section = await screen.findByRole("region", { name: "Repositories" });
    await waitFor(() => expect(section).toHaveTextContent("api"));
    expect(screen.getByTitle("/work/api")).toHaveTextContent("fix-login2 uncommitted +13 −1");
    expect(screen.getByTitle("/work/web")).toHaveTextContent("mainclean");
    expect(screen.getByTitle("/work/old")).toHaveTextContent("not found");
  });
});
