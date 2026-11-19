import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";
import { RemoteMedia, whereFrom } from "./RemoteMedia";
import { Image } from "./generative-ui/components";

describe("pictures from the web", () => {
  it("fetches nothing from a web host until asked, and keeps it shown once asked", () => {
    const { unmount } = render(<Markdown>{"![cat](https://cats.example/c.gif)"}</Markdown>);
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Image from cats\.example/ }));
    expect(screen.getByRole("img", { name: "cat" })).toHaveAttribute("src", "https://cats.example/c.gif");
    // Drawn again (a thread re-read, scrolled back): no second ask.
    unmount();
    render(<Markdown>{"![cat](https://cats.example/c.gif)"}</Markdown>);
    expect(screen.getByRole("img", { name: "cat" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /Image from tracker\.example/ })).toBeInTheDocument();
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
