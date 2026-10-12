import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Chart, niceTicks } from "./Chart";

const rows = [
  { week: "W1", open: 4, closed: 2 },
  { week: "W2", open: 6, closed: "" },
  { week: "W3", open: 3, closed: 5 },
];
const series = [
  { key: "open", title: "Opened" },
  { key: "closed", title: "Closed" },
];

describe("Chart", () => {
  it("draws one column per number, and none for a blank", () => {
    const { container } = render(<Chart rows={rows} x="week" series={series} />);
    expect(container.querySelectorAll("svg path")).toHaveLength(5);
    expect(screen.getByText("W2")).toBeInTheDocument();
  });

  it("keys two series in a legend, and leaves one to the title", () => {
    const { rerender } = render(<Chart title="Issues" rows={rows} x="week" series={series} />);
    expect(screen.getByRole("list")).toHaveTextContent("OpenedClosed");
    rerender(<Chart title="Issues" rows={rows} x="week" series={series.slice(0, 1)} />);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows the same rows as a table, a blank left blank", () => {
    render(<Chart rows={rows} x="week" series={series} source="Sample figures" />);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const cells = screen.getAllByRole("row").map((row) => row.textContent);
    expect(cells).toEqual(["OpenedClosed", "W142", "W26", "W335"]);
    expect(screen.getByText("Sample figures")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("reads each point out from the keyboard, every series at once", () => {
    render(<Chart variant="line" rows={rows} x="week" series={series} />);
    const plot = screen.getByRole("img");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("W14Opened2Closed");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("W26Opened–Closed");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stacks only what is above zero", () => {
    const { container } = render(
      <Chart variant="stackedBar" rows={[{ w: "a", p: 2, q: -1, r: 3 }]} x="w" series={["p", "q", "r"].map((key) => ({ key, title: key }))} />,
    );
    expect(container.querySelectorAll("svg path")).toHaveLength(2);
  });

  it("says when there is nothing to chart", () => {
    render(<Chart rows={[{ week: "W1", open: "n/a" }]} x="week" series={series} emptyText="No issues yet." />);
    expect(screen.getByText("No issues yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws eight series at most, and says how many it left out", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ key: `s${i}`, title: `S${i}` }));
    render(<Chart rows={[Object.fromEntries([["x", "a"], ...many.map((s, i) => [s.key, i + 1])])]} x="x" series={many} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText(/2 more series not drawn/)).toBeInTheDocument();
  });
});

describe("horizontal bars", () => {
  const buckets = [
    { b: "< 50 ms", n: 420 },
    { b: "50–100 ms", n: 860 },
    { b: "a bucket with a very long name indeed that cannot fit", n: 12 },
    { b: "missing", n: "" },
  ];

  it("names rows on the left, writes one series' values at the tips, and leaves a gap for a blank", () => {
    const { container } = render(<Chart orientation="horizontal" rows={buckets} x="b" series={[{ key: "n", title: "Requests" }]} />);
    expect(screen.getByRole("img", { name: /horizontal bar chart of 4 rows/ })).toBeInTheDocument();
    expect(container.querySelectorAll("svg path")).toHaveLength(3);
    expect(screen.getByText("< 50 ms")).toBeInTheDocument();
    expect(screen.getByText("860")).toBeInTheDocument();
    expect(screen.getByText(/^a bucket with.*…$/)).toBeInTheDocument();
    // A bar's data end is rounded on the right, its baseline end square.
    expect(container.querySelector("svg path")!.getAttribute("d")).toMatch(/^M\S+H\S+Q/);
  });

  it("reads each row out with the up and down keys", () => {
    render(<Chart orientation="horizontal" rows={buckets} x="b" series={series.slice(0, 1).map(() => ({ key: "n", title: "Requests" }))} />);
    const plot = screen.getByRole("img");
    fireEvent.keyDown(plot, { key: "ArrowDown" });
    fireEvent.keyDown(plot, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("50–100 ms860");
    fireEvent.keyDown(plot, { key: "ArrowUp" });
    expect(screen.getByRole("status")).toHaveTextContent("< 50 ms420");
  });

  it("groups several series per row with a legend, and stacks with the total at the tip", () => {
    const rows = [{ b: "web", ok: 5, ko: 2 }, { b: "api", ok: 9, ko: 4 }];
    const two = [{ key: "ok", title: "Passed" }, { key: "ko", title: "Failed" }];
    const { container, rerender } = render(<Chart orientation="horizontal" rows={rows} x="b" series={two} />);
    expect(container.querySelectorAll("svg path")).toHaveLength(4);
    expect(screen.getByRole("list")).toHaveTextContent("PassedFailed");
    rerender(<Chart orientation="horizontal" variant="stackedBar" rows={rows} x="b" series={two} />);
    expect(screen.getByRole("img", { name: /stacked horizontal bar chart/ })).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("13")).toBeInTheDocument();
  });

  it("keeps lines vertical", () => {
    render(<Chart orientation="horizontal" variant="line" rows={rows} x="week" series={series} />);
    expect(screen.getByRole("img", { name: /line chart/ })).toBeInTheDocument();
  });
});

describe("a chart kept live", () => {
  it("drops a hover on a row that is gone, rather than crashing", () => {
    const { rerender } = render(<Chart rows={rows} x="week" series={series} />);
    const plot = screen.getByRole("img");
    fireEvent.keyDown(plot, { key: "End" });
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("W3");
    rerender(<Chart rows={rows.slice(0, 1)} x="week" series={series} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws in the same colours in the roer-ui plugin's terminal pane", () => {
    const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
    // The first set is the default (dark) theme's, which the pane uses.
    const panel = Array.from({ length: 8 }, (_, i) => new RegExp(`--roer-series-${i + 1}: (#[0-9a-f]{6})`).exec(css)?.[1]);
    const plugin = readFileSync(resolve(__dirname, "../../claude-plugin/roer-ui/hooks/register.tsx"), "utf8");
    const listed = /const SERIES = \[([^\]]*)\]/.exec(plugin)?.[1].match(/#[0-9a-f]{6}/g);
    expect(listed).toEqual(panel);
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 and always crosses zero", () => {
    expect(niceTicks(0, 9)).toEqual([0, 5, 10]);
    expect(niceTicks(0, 100)).toEqual([0, 50, 100]);
    expect(niceTicks(-3, 7)).toEqual([-5, 0, 5, 10]);
    expect(niceTicks(-3, 3)).toEqual([-4, -2, 0, 2, 4]);
    expect(niceTicks(0.1, 0.35)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });
});
