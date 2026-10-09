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
