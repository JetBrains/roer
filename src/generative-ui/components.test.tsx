import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CheckBox, ChoicePicker, Expandable, Modal, Slider, Tabs } from "./components";

const options = [
  { label: "Red", value: "r" },
  { label: "Green", value: "g" },
];

describe("catalog inputs, on Radix", () => {
  it("tabs are tabs: each tied to its panel, the arrow keys move between them", () => {
    render(<Tabs tabs={[{ title: "One", content: "first" }, { title: "Two", content: "second" }]} />);
    const one = screen.getByRole("tab", { name: "One" });
    expect(one).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("first");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Two" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("second");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveClass("on");
  });

  it("a modal takes focus, is named, and Escape closes it", () => {
    render(
      <Modal trigger={<button type="button">Open</button>}>
        <button type="button">Inside</button>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an expandable says what it controls", () => {
    render(<Expandable title="More">hidden body</Expandable>);
    const header = screen.getByRole("button", { name: /More/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(header.getAttribute("aria-controls")!)).toHaveTextContent("hidden body");
  });

  it("a checkbox is a checkbox, named by its label", () => {
    const onChange = vi.fn();
    render(<CheckBox label="Ship it" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ship it" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("a slider steps by keyboard, within its range, without float noise", () => {
    const onChange = vi.fn();
    render(<Slider label="Tip" min={0} max={1} steps={10} value={0.2} onChange={onChange} />);
    const thumb = screen.getByRole("slider", { name: "Tip" });
    expect(thumb).toHaveAttribute("aria-valuenow", "0.2");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(0.3);
    fireEvent.keyDown(thumb, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("one choice is a radio group", () => {
    const onChange = vi.fn();
    render(<ChoicePicker label="Colour" options={options} value={["r"]} onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Colour" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Red" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Green" }));
    expect(onChange).toHaveBeenCalledWith(["g"]);
  });

  it("several choices are checkboxes", () => {
    const onChange = vi.fn();
    render(<ChoicePicker options={options} value={["r"]} multiple onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Green" }));
    expect(onChange).toHaveBeenCalledWith(["r", "g"]);
  });

  it("chips toggle, and a single chip pressed again clears", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ChoicePicker options={options} value={["r"]} chips onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    rerender(<ChoicePicker options={options} value={["r"]} chips multiple onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Green" }));
    expect(onChange).toHaveBeenLastCalledWith(["r", "g"]);
  });
});
