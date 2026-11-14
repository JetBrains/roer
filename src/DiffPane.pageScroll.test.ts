import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";

import { pageScroll } from "./DiffPane";

const box = () => {
  const one = document.createElement("div");
  Object.defineProperty(one, "clientHeight", { value: 400 });
  Object.defineProperty(one, "scrollHeight", { value: 5000 });
  one.scrollTop = 1000;
  return one;
};

const key = (name: string, over: Partial<KeyboardEvent> = {}, target: EventTarget = document.body) =>
  ({ key: name, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, target, ...over }) as KeyboardEvent;

describe("pageScroll", () => {
  it("scrolls a page less a line with Page Down and Space, and back with Page Up and Shift+Space", () => {
    const one = box();
    pageScroll(key("PageDown"), one)!();
    expect(one.scrollTop).toBe(1360);
    pageScroll(key(" "), one)!();
    expect(one.scrollTop).toBe(1720);
    pageScroll(key("PageUp"), one)!();
    pageScroll(key(" ", { shiftKey: true }), one)!();
    expect(one.scrollTop).toBe(1000);
  });

  it("goes to the top and the bottom with Home and End", () => {
    const one = box();
    pageScroll(key("End"), one)!();
    expect(one.scrollTop).toBe(5000);
    pageScroll(key("Home"), one)!();
    expect(one.scrollTop).toBe(0);
  });

  it("leaves other keys, modified ones, and keys from a control alone", () => {
    const one = box();
    expect(pageScroll(key("ArrowDown"), one)).toBeNull();
    expect(pageScroll(key("End", { metaKey: true }), one)).toBeNull();
    expect(pageScroll(key(" ", {}, document.createElement("button")), one)).toBeNull();
    expect(pageScroll(key("PageDown"), null)).toBeNull();
  });
});
