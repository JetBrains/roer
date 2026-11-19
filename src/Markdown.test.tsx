import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";

vi.mock("./lib/github", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

// jsdom cannot lay a graph out: mermaid stands in, drawing a labelled SVG, or failing on "oops".
const mermaid = vi.hoisted(() => ({
  mermaidAPI: { defaultConfig: { secure: [] as string[] } },
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => {
    if (source.includes("oops")) throw new Error("Parse error on line 1");
    return { svg: `<svg id="${id}"><text>drawn: ${source.split("\n")[1]?.trim() ?? ""}</text></svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

describe("Markdown", () => {
  it("keeps Roer's Markdown styles beside the caller's class", () => {
    const { container } = render(<Markdown className="note-card-md md-inline">text</Markdown>);
    expect(container.firstElementChild?.className).toBe("file-markdown note-card-md md-inline");
  });

  it("does not repeat the base class a caller passes", () => {
    const { container } = render(<Markdown className="file-markdown pr-md">text</Markdown>);
    expect(container.firstElementChild?.className).toBe("file-markdown pr-md");
  });

  it("marks the words asked for, in any case, inside the formatting and not in its markup", () => {
    const { container } = render(<Markdown marks={["cents"]}>{"The **Cents** are lost; see [cents](https://example.com/cents)."}</Markdown>);
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Cents", "cents"]);
    expect(container.querySelector("strong mark")?.textContent).toBe("Cents");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/cents");
  });

  it("marks no word inside raw HTML's attributes", () => {
    const { container } = render(<Markdown marks={["cents"]}>{'<div title="cents" lang="cents">c</div> cents'}</Markdown>);
    expect(container.querySelector("div[lang]")?.getAttribute("lang")).toBe("cents");
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["cents"]);
  });

  it("can leave images out, saying what they were, so reading loads nothing", () => {
    const { container } = render(<Markdown images={false}>{"![a chart](https://example.com/chart.png) <img src=\"https://example.com/x.png\" alt=\"x\">"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("[image: a chart]");
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
    // A picture from the web waits to be asked for; once shown, it has no handler either.
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Image from example\.com/ }));
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("draws a mermaid block as its diagram, its source a click away, and leaves other code as code", async () => {
    render(<Markdown>{"```mermaid\nflowchart LR\n  A --> B\n```\n\n```ts\nconst x = 1;\n```"}</Markdown>);
    expect(await screen.findByRole("img", { name: "Diagram" })).toHaveTextContent("drawn: A --> B");
    expect(mermaid.render.mock.calls[0][1]).toBe("flowchart LR\n  A --> B");
    expect(screen.getByText("const x = 1;").closest("pre")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText(/flowchart LR/).closest("pre")).toBeInTheDocument();
  });

  it("keeps a drawn diagram as it is when the text around it is drawn again, rather than redrawing it", async () => {
    mermaid.render.mockClear();
    const text = "```mermaid\nflowchart LR\n  K --> L\n```";
    const { rerender } = render(<Markdown>{text}</Markdown>);
    const drawn = await screen.findByRole("img", { name: "Diagram" });
    rerender(<Markdown>{text}</Markdown>);
    // The same element: not mounted again, so nothing blinks or changes height.
    expect(screen.getByRole("img", { name: "Diagram" })).toBe(drawn);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("draws no diagram where nothing but text is shown, as it shows no pictures", () => {
    mermaid.render.mockClear();
    render(<Markdown images={false}>{"```mermaid\nflowchart LR\n  X --> Y\n```"}</Markdown>);
    expect(screen.getByText(/flowchart LR/).closest("pre")).toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("does not leave the last diagram up as the new source's while that is drawn", async () => {
    const { rerender } = render(<Markdown>{"```mermaid\nflowchart LR\n  P --> Q\n```"}</Markdown>);
    expect(await screen.findByRole("img", { name: "Diagram" })).toHaveTextContent("drawn: P --> Q");
    rerender(<Markdown>{"```mermaid\noops\n```"}</Markdown>);
    expect(screen.queryByText("drawn: P --> Q")).toBeNull();
    expect(await screen.findByText(/Could not draw this diagram/)).toBeInTheDocument();
  });

  it("shows the source and what went wrong when a diagram cannot be drawn", async () => {
    render(<Markdown>{"```mermaid\noops\n```"}</Markdown>);
    await waitFor(() => expect(screen.getByText(/Could not draw this diagram: Parse error on line 1/)).toBeInTheDocument());
    expect(screen.getByText("oops").closest("pre")).toBeInTheDocument();
  });
});
