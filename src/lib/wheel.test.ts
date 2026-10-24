import { describe, expect, it } from "vitest";

import { cellAt, nextEncoding, wheelLines, wheelReports, xtversionReply, type WheelCarry } from "./wheel";

describe("the wheel in a tmux session", () => {
  it("scrolls a line for every cell height a trackpad moves, carrying the rest", () => {
    const carry: WheelCarry = { pixels: 0 };
    // A swipe's small deltas, then its momentum: nothing is thrown away.
    const swipe = [4, 6, 9, 12, 20, 35, 20, 9, 4, 2, 1];
    const lines = swipe.map((deltaY) => wheelLines(carry, { deltaY, deltaMode: 0 }, 17, 40));
    expect(lines.reduce((a, b) => a + b, 0)).toBe(Math.trunc(122 / 17));
    expect(carry.pixels).toBeCloseTo(122 % 17);
  });

  it("drops what was carried when the direction turns, and counts lines and pages as such", () => {
    const carry: WheelCarry = { pixels: 10 };
    expect(wheelLines(carry, { deltaY: -12, deltaMode: 0 }, 17, 40)).toBe(0);
    expect(carry.pixels).toBe(-12);
    expect(wheelLines({ pixels: 0 }, { deltaY: 3, deltaMode: 1 }, 17, 40)).toBe(3);
    expect(wheelLines({ pixels: 0 }, { deltaY: -1, deltaMode: 2 }, 17, 40)).toBe(-40);
    expect(wheelLines({ pixels: 0 }, { deltaY: 100000, deltaMode: 0 }, 17, 40)).toBe(200);
    expect(wheelLines({ pixels: 0 }, { deltaY: 5, deltaMode: 0 }, 0, 40)).toBe(0);
  });

  it("writes one report per line, in the encoding tmux asked for", () => {
    expect(wheelReports(-2, 10, 5, true)).toBe("\x1b[<64;10;5M\x1b[<64;10;5M");
    expect(wheelReports(1, 10, 5, true)).toBe("\x1b[<65;10;5M");
    expect(wheelReports(1, 1, 1, false)).toBe("\x1b[M" + String.fromCharCode(97, 33, 33));
    expect(wheelReports(0, 1, 1, true)).toBe("");
  });

  it("answers XTVERSION with Roer's name, which tmux's wheel binding looks for", () => {
    expect(xtversionReply()).toBe("\x1bP>|Roer\x1b\\");
  });

  it("follows the mouse encoding a program sets and resets, leaving others to xterm", () => {
    expect(nextEncoding("default", [1000, 1006], true)).toBe("sgr");
    expect(nextEncoding("sgr", [1006], false)).toBe("default");
    expect(nextEncoding("sgr", [1015], true)).toBe("other");
    expect(nextEncoding("other", [1006], false)).toBe("other");
    expect(nextEncoding("sgr", [[1002, 1006]], false)).toBe("default");
    expect(nextEncoding("default", [25], true)).toBe("default");
  });

  it("finds the cell under the pointer, kept on the grid", () => {
    expect(cellAt(0, 800, 80)).toBe(1);
    expect(cellAt(15, 800, 80)).toBe(2);
    expect(cellAt(799.9, 800, 80)).toBe(80);
    expect(cellAt(900, 800, 80)).toBe(80);
    expect(cellAt(-5, 800, 80)).toBe(1);
  });
});
