import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";

vi.mock("./lib/github", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

describe("Markdown", () => {
  it("keeps Roer's Markdown styles beside the caller's class", () => {
    const { container } = render(<Markdown className="note-card-md md-inline">text</Markdown>);
    expect(container.firstElementChild?.className).toBe("file-markdown note-card-md md-inline");
  });

  it("does not repeat the base class a caller passes", () => {
    const { container } = render(<Markdown className="file-markdown pr-md">text</Markdown>);
    expect(container.firstElementChild?.className).toBe("file-markdown pr-md");
  });

  it("renders the HTML GitHub allows", () => {
    const { container } = render(
      <Markdown>{"<div><em>emphasis</em></div>\n\n<details><summary>More</summary>hidden</details>"}</Markdown>,
    );
    expect(container.querySelector("em")?.textContent).toBe("emphasis");
    expect(container.querySelector("details summary")?.textContent).toBe("More");
    expect(container.textContent).not.toContain("<em>");
  });

  it("removes scripts, handlers, styles and javascript links", () => {
    const { container } = render(
      <Markdown>
        {'<script>alert(1)</script><p style="color:red" onclick="alert(2)">styled</p>' +
          '<img src="https://example.com/a.png" onerror="alert(3)"><a href="javascript:alert(4)">bad</a><iframe src="https://example.com"></iframe>'}
      </Markdown>,
    );
    expect(container.querySelector("script, iframe")).toBeNull();
    const p = container.querySelector("p");
    expect(p?.getAttribute("style")).toBeNull();
    expect(p?.getAttribute("onclick")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
