import { describe, expect, it } from "vitest";

import { leavesDraft, settlesPrompt } from "./TerminalView";

const key = (key: string, mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {}) =>
  new KeyboardEvent("keydown", { key, ...mods });

describe("settlesPrompt", () => {
  it("is a key that confirms or cancels a question or a permission prompt", () => {
    expect(settlesPrompt(key("Enter"))).toBe(true);
    expect(settlesPrompt(key("Escape"))).toBe(true);
    expect(settlesPrompt(key("c", { ctrlKey: true }))).toBe(true);
  });

  it("is not moving between the choices, nor typing an answer that is not sent yet", () => {
    for (const one of ["ArrowUp", "ArrowDown", "Tab", "a", "1", "Backspace"]) expect(settlesPrompt(key(one))).toBe(false);
    expect(settlesPrompt(key("c", { metaKey: true }))).toBe(false);
    expect(settlesPrompt(key("Enter", { altKey: true }))).toBe(false);
    expect(settlesPrompt(key("Enter", { shiftKey: true }))).toBe(false);
  });

  it("leaves what counts as a draft as it was", () => {
    expect(leavesDraft(key("a"))).toBe(true);
    expect(leavesDraft(key("Enter"))).toBe(false);
  });
});
