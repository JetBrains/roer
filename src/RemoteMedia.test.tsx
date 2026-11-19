import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";
import { RemoteMedia, whereFrom } from "./RemoteMedia";
import { SettingsDialog } from "./SettingsDialog";
import { Image } from "./generative-ui/components";
import { allowHost, remoteMediaPrefs, setAlwaysShow } from "./lib/remoteMedia";
import { useSettingsOpener } from "./lib/settingsNav";

beforeEach(() => localStorage.clear());

describe("pictures from the web", () => {
  it("fetches nothing from a web host until asked, and keeps it shown once asked", () => {
    const { unmount } = render(<Markdown>{"![cat](https://cats.example/c.gif)"}</Markdown>);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("group", { name: "Image from cats.example, not loaded" })).toHaveTextContent("cat");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("img", { name: "cat" })).toHaveAttribute("src", "https://cats.example/c.gif");
    // Drawn again (a thread re-read, scrolled back): no second ask.
    unmount();
    render(<Markdown>{"![cat](https://cats.example/c.gif)"}</Markdown>);
    expect(screen.getByRole("img", { name: "cat" })).toBeInTheDocument();
  });

  it("lets a host through for good, every picture of it, and only it", () => {
    render(<Markdown>{"![a](https://dogs.example/a.png) ![b](https://dogs.example/b.png) ![c](https://other.example/c.png)"}</Markdown>);
    fireEvent.click(screen.getAllByRole("button", { name: "Always from dogs.example" })[0]);
    expect(screen.getByRole("img", { name: "a" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "b" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "c" })).toBeNull();
    expect(remoteMediaPrefs().hosts).toEqual(["dogs.example"]);
  });

  it("shows every one at once when Settings says always", () => {
    setAlwaysShow(true);
    render(<Markdown>{"![a](https://anywhere.example/a.png)"}</Markdown>);
    expect(screen.getByRole("img", { name: "a" })).toBeInTheDocument();
  });

  it("goes to Settings at Privacy from a placeholder, where the choice and the hosts let through are", () => {
    const open = vi.fn();
    renderHook(() => useSettingsOpener(open));
    render(<Markdown>{"![a](https://birds.example/a.png)"}</Markdown>);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(open).toHaveBeenCalledWith("privacy");

    fireEvent.click(screen.getByRole("button", { name: "Always from birds.example" }));
    render(<SettingsDialog section="privacy" onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
    const always = screen.getByRole("switch", { name: "Load pictures from the web without asking" });
    expect(always).not.toBeChecked();
    expect(screen.getByText("1 host, added from pictures' placeholders.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask again for birds.example" }));
    expect(remoteMediaPrefs().hosts).toEqual([]);
    act(() => fireEvent.click(always));
    expect(remoteMediaPrefs().always).toBe(true);
  });

  it("lists a hundred hosts let through in a box of their own, with a filter and Remove all", () => {
    for (let i = 0; i < 100; i += 1) allowHost(`host${String(i).padStart(3, "0")}.example`);
    render(<SettingsDialog section="privacy" onClose={() => undefined} />);
    expect(screen.getByText("100 hosts, added from pictures' placeholders.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Hosts loaded without asking" });
    expect(list.children).toHaveLength(100);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter hosts" }), { target: { value: "host04" } });
    expect(list.children).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(remoteMediaPrefs().hosts).toEqual([]);
  });

  it("offers no Settings where the window cannot open them", () => {
    render(<Markdown>{"![a](https://birds.example/a.png)"}</Markdown>);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("draws a picture carried in the text, and GitHub's own, at once", () => {
    render(
      <Markdown>
        {"![dot](data:image/png;base64,iVBORw0K) ![shot](https://private-user-images.githubusercontent.com/1/a.png) " +
          "![file](https://github.com/user-attachments/assets/abc)"}
      </Markdown>,
    );
    expect(screen.getByRole("img", { name: "dot" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "shot" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "file" })).toBeInTheDocument();
  });

  it("holds an agent's view to the same rule", () => {
    render(<Image url="https://tracker.example/p.png" description="pixel" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("group", { name: "Image from tracker.example, not loaded" })).toBeInTheDocument();
  });

  it("knows where a source points", () => {
    expect(whereFrom("data:image/svg+xml;utf8,<svg/>")).toEqual({ kind: "inline" });
    expect(whereFrom("//cdn.example/x.png")).toEqual({ kind: "web", host: "cdn.example", direct: false });
    expect(whereFrom("https://github.com/owner/repo/raw/main/x.png")).toEqual({ kind: "web", host: "github.com", direct: false });
    expect(whereFrom("shots/a.png")).toEqual({ kind: "other" });
  });

  it("draws what reaches nothing off the page as it is", () => {
    render(
      <RemoteMedia src="shots/a.png">
        <span>local</span>
      </RemoteMedia>,
    );
    expect(screen.getByText("local")).toBeInTheDocument();
  });
});
