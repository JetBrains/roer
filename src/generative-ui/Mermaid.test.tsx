import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAll } from "./apply";
import { GenerativeSurface } from "./GenerativeSurface";
import { Mermaid, nodeIdOf, zoomAbout } from "./Mermaid";
import { A2UI_VERSION, type Component } from "./schema";

// jsdom cannot lay a graph out, so mermaid stands in with an SVG shaped like
// the one it draws for `flowchart LR; cart[Cart] --> pay{Paid?}`.
const mermaid = vi.hoisted(() => ({
  mermaidAPI: { defaultConfig: { secure: ["secure", "securityLevel"] } },
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => {
    // As mermaid does before it draws: whatever has the id goes.
    document.getElementById(id)?.remove();
    if (source.includes("oops")) throw new Error("Parse error on line 1");
    return {
      svg:
        `<svg id="${id}"><g class="nodes">` +
        `<g class="node default" id="${id}-flowchart-cart-0"><rect></rect><g class="label"><text>Cart</text></g></g>` +
        `<g class="node default" id="${id}-flowchart-pay-1"><rect></rect><g class="label"><text>Paid?</text></g></g>` +
        `</g></svg>`,
    };
  }),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

beforeEach(() => {
  mermaid.initialize.mockClear();
  mermaid.render.mockClear();
});

describe("nodeIdOf", () => {
  const element = (attrs: Record<string, string>) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
    return g;
  };

  it("reads a flowchart, class or state node's id out of its DOM id", () => {
    expect(nodeIdOf(element({ id: "m1-flowchart-pay-1" }), "m1")).toBe("pay");
    expect(nodeIdOf(element({ id: "m1-classId-Order-3" }), "m1")).toBe("Order");
    expect(nodeIdOf(element({ id: "m1-flowchart-a-b-12" }), "m1")).toBe("a-b");
  });

  it("prefers data-id, which sequence actors and edges carry", () => {
    expect(nodeIdOf(element({ id: "whatever", "data-id": "Alice" }), "m1")).toBe("Alice");
  });

  it("falls back to the DOM id without the diagram's own prefix", () => {
    expect(nodeIdOf(element({ id: "m1-root" }), "m1")).toBe("root");
  });
});

describe("Mermaid", () => {
  it("draws the source with mermaid, strict, in Roer's colours", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" title="Checkout" />);
    expect(await screen.findByText("Paid?")).toBeInTheDocument();
    expect(screen.getByText("Checkout")).toBeInTheDocument();
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "base", suppressErrorRendering: true }),
    );
  });

  it("draws with dagre, and a diagram cannot ask for ELK, which the app leaves out", async () => {
    render(<Mermaid source={"---\nconfig:\n  layout: elk\n---\nflowchart LR; cart --> pay"} />);
    expect(await screen.findByText("Paid?")).toBeInTheDocument();
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ layout: "dagre", secure: ["secure", "securityLevel", "layout"] }),
    );
    // Only drawn: nothing to click on without `onComment`.
    expect(screen.queryByRole("button", { name: /Comment on/ })).toBeNull();
  });

  it("keeps the diagram on screen while it redraws, and after a redraw that comes out the same", async () => {
    const { rerender } = render(<Mermaid source="flowchart LR; cart --> pay" />);
    expect(await screen.findByText("Paid?")).toBeInTheDocument();

    // A change that draws the same thing, such as a trailing newline.
    rerender(<Mermaid source={"flowchart LR; cart --> pay\n"} />);
    expect(screen.getByText("Paid?")).toBeInTheDocument();
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(mermaid.render.mock.calls[1][0]).not.toBe(mermaid.render.mock.calls[0][0]);
    await waitFor(() => expect(document.querySelector(`svg#${mermaid.render.mock.calls[1][0]}`)).not.toBeNull());
    expect(screen.getByText("Paid?")).toBeInTheDocument();
  });

  it("shows the parse error and the source rather than a blank", async () => {
    render(<Mermaid source="flowchart oops" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Parse error on line 1");
    expect(screen.getByText("flowchart oops")).toBeInTheDocument();
  });

  it("an empty source draws no diagram and asks mermaid for nothing", () => {
    render(<Mermaid source="  " />);
    expect(screen.getByText("No diagram.")).toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("a comment on a node starts a thread, reported with its id in the source and shown until the owner answers", async () => {
    const onComment = vi.fn();
    render(<Mermaid source="flowchart LR; cart --> pay" onComment={onComment} />);
    fireEvent.click(await screen.findByRole("button", { name: "Comment on Paid?" }));

    const panel = screen.getByRole("region", { name: "Threads on Paid?" });
    fireEvent.change(within(panel).getByLabelText("New comment on Paid?"), { target: { value: "  what if it times out?  " } });
    fireEvent.click(within(panel).getByRole("button", { name: "Comment" }));

    expect(onComment).toHaveBeenCalledWith({ action: "comment", node: "pay", label: "Paid?", text: "what if it times out?" });
    // Shown at once, as sending, and counted on the node.
    expect(within(panel).getByText("what if it times out?")).toBeInTheDocument();
    expect(within(panel).getByText("sending")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Comment on Paid?, 1 open thread" })).toHaveClass("gen-mermaid-has-notes");
  });

  it("Enter on a focused node opens its threads too, and Close puts them away", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" onComment={vi.fn()} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Comment on Cart" }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: /Threads on/ })).toBeNull();
  });

  const THREADS = [
    {
      id: "t1",
      node: "pay",
      author: "You",
      text: "what if it times out?",
      replies: [{ author: "Agent", text: "Added a retry." }],
      state: "open" as const,
    },
    { id: "t2", node: "pay", author: "Agent", text: "old question", replies: [], state: "resolved" as const },
  ];

  it("badges nodes with open threads and lists them under the diagram", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" notes={THREADS} onComment={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Comment on Paid?, 1 open thread" })).toHaveClass("gen-mermaid-has-notes");
    expect(screen.getByRole("button", { name: "Comment on Cart" })).not.toHaveClass("gen-mermaid-has-notes");

    fireEvent.click(await screen.findByRole("button", { name: "Paid? · 1" }));
    const panel = screen.getByRole("region", { name: "Threads on Paid?" });
    expect(within(panel).getByText("what if it times out?")).toBeInTheDocument();
    expect(within(panel).getByText("Added a retry.")).toBeInTheDocument();
    expect(within(panel).getByText("1 resolved")).toBeInTheDocument();
  });

  it("replies, resolves and reopens a thread by its id, each shown at once", async () => {
    const onComment = vi.fn();
    render(<Mermaid source="flowchart LR; cart --> pay" notes={THREADS} onComment={onComment} />);
    fireEvent.click(await screen.findByRole("button", { name: /Comment on Paid\?/ }));
    const panel = screen.getByRole("region", { name: "Threads on Paid?" });

    fireEvent.click(within(panel).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(panel).getByLabelText("Reply"), { target: { value: "make it two" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Reply" }));
    expect(onComment).toHaveBeenLastCalledWith({ action: "reply", node: "pay", label: "Paid?", thread: "t1", text: "make it two" });
    expect(within(panel).getByText("make it two")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Resolve" }));
    expect(onComment).toHaveBeenLastCalledWith({ action: "resolve", node: "pay", label: "Paid?", thread: "t1" });
    expect(within(panel).getByText("2 resolved")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Comment on Paid?" })).not.toHaveClass("gen-mermaid-has-notes");

    fireEvent.click(within(panel).getByText("2 resolved"));
    fireEvent.click(within(panel).getAllByRole("button", { name: "Reopen" })[0]);
    expect(onComment).toHaveBeenLastCalledWith(expect.objectContaining({ action: "reopen" }));
  });

  it("drops what it showed once the owner sends new threads, and keeps it while they resend the old", async () => {
    const onComment = vi.fn();
    const { rerender } = render(<Mermaid source="flowchart LR; cart --> pay" notes={[]} onComment={onComment} />);
    fireEvent.click(await screen.findByRole("button", { name: "Comment on Cart" }));
    fireEvent.change(screen.getByLabelText("New comment on Cart"), { target: { value: "split it" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("sending")).toBeInTheDocument();

    rerender(<Mermaid source="flowchart LR; cart --> pay" notes={[]} onComment={onComment} />);
    expect(screen.getByText("sending")).toBeInTheDocument();

    const answered = [{ id: "c1", node: "cart", author: "You", text: "split it", replies: [], state: "open" as const }];
    rerender(<Mermaid source="flowchart LR; cart --> pay" notes={answered} onComment={onComment} />);
    expect(screen.queryByText("sending")).toBeNull();
    expect(screen.getAllByText("split it")).toHaveLength(1);
  });

  it("lists a node's files in its panel and opens them", async () => {
    const onOpenFile = vi.fn();
    render(
      <Mermaid
        source="flowchart LR; cart --> pay"
        files={[{ node: "pay", path: "src/pay.ts" }, { node: "cart", path: "src/cart.ts" }]}
        onComment={vi.fn()}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Comment on Paid?" }));
    const list = screen.getByRole("list", { name: "Files of Paid?" });
    expect(within(list).queryByText("src/cart.ts")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "src/pay.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/pay.ts");
  });

  it("without onComment, threads are still badged but nothing opens", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" notes={THREADS} />);
    await screen.findByText("Paid?");
    await waitFor(() => expect(document.querySelector(".gen-mermaid-has-notes")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /Comment on/ })).toBeNull();
  });
});

describe("zoom", () => {
  it("zoomAbout keeps the point under the pointer where it was, within 25% to 400%", () => {
    const view = zoomAbout({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(view).toEqual({ scale: 2, x: -100, y: -50 });
    // The diagram point under (100, 50) is still (100, 50): (100 - x) / scale.
    expect((100 - view.x) / view.scale).toBe(100);
    expect(zoomAbout({ scale: 3, x: 0, y: 0 }, 10, 0, 0).scale).toBe(4);
    expect(zoomAbout({ scale: 0.5, x: 0, y: 0 }, 0.1, 0, 0).scale).toBe(0.25);
  });

  const canvas = () => document.querySelector<HTMLElement>(".gen-mermaid-canvas")!;
  const viewport = () => document.querySelector<HTMLElement>(".gen-mermaid-viewport")!;

  it("⌘ or Ctrl and the wheel zoom; a plain wheel is the page's until zoomed in, then pans", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" />);
    await screen.findByText("Paid?");

    const plain = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    viewport().dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("100%");

    const pinch = new WheelEvent("wheel", { deltaY: -50, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void viewport().dispatchEvent(pinch));
    expect(pinch.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("165%");

    const pan = new WheelEvent("wheel", { deltaX: 10, deltaY: 20, bubbles: true, cancelable: true });
    act(() => void viewport().dispatchEvent(pan));
    expect(pan.defaultPrevented).toBe(true);
    expect(canvas().style.transform).toBe("translate(-10px, -20px)");
    expect(canvas().style.width).toMatch(/^16\d\.\d+%$/);
  });

  it("takes WebKit's pinch gestures", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" />);
    await screen.findByText("Paid?");
    const gesture = (type: string, scale: number) =>
      act(() => void viewport().dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { scale, clientX: 0, clientY: 0 })));
    gesture("gesturestart", 1);
    gesture("gesturechange", 1.5);
    gesture("gesturechange", 2);
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("200%");
  });

  it("the buttons step the zoom and the percentage puts it back", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" />);
    await screen.findByText("Paid?");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("156%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("125%");
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(canvas().style.transform).toBe("translate(0px, 0px)");
    expect(canvas().style.width).toBe("100%");
  });

  it("a drag pans, and letting go over a node does not open it", async () => {
    render(<Mermaid source="flowchart LR; cart --> pay" onComment={vi.fn()} />);
    const pay = await screen.findByRole("button", { name: "Comment on Paid?" });
    fireEvent.pointerDown(pay, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(viewport(), { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(viewport(), { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.click(pay);
    expect(canvas().style.transform).toBe("translate(30px, 20px)");
    expect(screen.queryByRole("region", { name: /Threads on/ })).toBeNull();
    // A click without a drag still does.
    fireEvent.click(pay);
    expect(screen.getByRole("region", { name: "Threads on Paid?" })).toBeInTheDocument();
  });
});

describe("Mermaid in a surface", () => {
  function draw(components: Component[], dataModel = {}) {
    const state = applyAll([{ version: A2UI_VERSION, createSurface: { surfaceId: "s", components, dataModel } }]);
    const onAction = vi.fn();
    render(
      <GenerativeSurface surface={state.surfaces.s} dataModel={state.dataModels.s} onSetValue={vi.fn()} onAction={onAction} />,
    );
    return onAction;
  }

  it("reads its source from the data model and reports comments as diagramComment", async () => {
    const onAction = draw([{ id: "root", component: "Mermaid", source: { path: "/diagram" } }], {
      diagram: "flowchart LR; cart --> pay",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Comment on Cart" }));
    fireEvent.change(screen.getByLabelText("New comment on Cart"), { target: { value: "split it" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onAction).toHaveBeenCalledWith(
      { name: "diagramComment", context: { action: "comment", node: "cart", label: "Cart", text: "split it" } },
      "root",
    );
  });

  it("reads its threads from the data model", async () => {
    draw([{ id: "root", component: "Mermaid", source: "flowchart LR; cart --> pay", notes: { path: "/threads" } }], {
      threads: [{ id: "t1", node: "pay", text: "why?" }, { node: "pay", text: "no id, dropped" }],
    });
    expect(await screen.findByRole("button", { name: "Comment on Paid?, 1 open thread" })).toBeInTheDocument();
  });

  it("takes another event name, or no comments at all", async () => {
    const onAction = draw([
      { id: "root", component: "Column", children: ["a", "b"] },
      { id: "a", component: "Mermaid", source: "flowchart LR; cart --> pay", commentEvent: "flowNote" },
      { id: "b", component: "Mermaid", source: "flowchart LR; cart --> pay", comments: false },
    ]);
    const carts = await screen.findAllByRole("button", { name: "Comment on Cart" });
    expect(carts).toHaveLength(1);
    fireEvent.click(carts[0]);
    fireEvent.change(screen.getByLabelText("New comment on Cart"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ name: "flowNote" }), "a");
  });
});
