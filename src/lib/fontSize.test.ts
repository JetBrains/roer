import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_FONT_SIZE, fontSize, setFontSize, stepFontSize } from "./fontSize";

describe("font size", () => {
  afterEach(() => {
    setFontSize("terminal", null);
    setFontSize("code", null);
  });

  it("steps each area on its own and keeps only what is off the default", () => {
    stepFontSize("terminal", 1);
    stepFontSize("terminal", 1);
    expect(fontSize("terminal")).toBe(DEFAULT_FONT_SIZE.terminal + 2);
    expect(fontSize("code")).toBe(DEFAULT_FONT_SIZE.code);
    expect(localStorage.getItem("roer:font-size:terminal")).toBe(String(DEFAULT_FONT_SIZE.terminal + 2));
    stepFontSize("terminal", 0);
    expect(fontSize("terminal")).toBe(DEFAULT_FONT_SIZE.terminal);
    expect(localStorage.getItem("roer:font-size:terminal")).toBeNull();
  });

  it("sets the code's size and whole-pixel line heights as CSS variables", () => {
    setFontSize("code", 16);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--code-font-size")).toBe("16px");
    expect(style.getPropertyValue("--code-line-height")).toBe("24px");
    expect(style.getPropertyValue("--diff-line-height")).toBe("27px");
  });

  it("stays within readable bounds", () => {
    setFontSize("code", 100);
    expect(fontSize("code")).toBe(28);
    setFontSize("code", 1);
    expect(fontSize("code")).toBe(9);
  });
});
