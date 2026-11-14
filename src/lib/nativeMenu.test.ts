import { afterEach, describe, expect, it } from "vitest";
import { shutNativeMenu } from "./nativeMenu";

const rightClick = (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event.defaultPrevented;
};

let undo = () => {};
afterEach(() => {
  undo();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

describe("shutNativeMenu", () => {
  it("leaves a browser page's menu alone", () => {
    undo = shutNativeMenu();
    document.body.innerHTML = "<div id=a></div>";
    expect(rightClick(document.getElementById("a")!)).toBe(false);
  });

  describe("in Roer's window", () => {
    const tauri = () => {
      (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
      undo = shutNativeMenu();
    };

    it("shuts it over the page and the terminal, xterm's textarea too", () => {
      tauri();
      document.body.innerHTML = '<div id=a></div><div class="xterm"><textarea id=t></textarea></div>';
      expect(rightClick(document.getElementById("a")!)).toBe(true);
      expect(rightClick(document.getElementById("t")!)).toBe(true);
    });

    it("keeps it in text fields", () => {
      tauri();
      document.body.innerHTML = '<input id=i><textarea id=t></textarea><input id=c type=checkbox>';
      expect(rightClick(document.getElementById("i")!)).toBe(false);
      expect(rightClick(document.getElementById("t")!)).toBe(false);
      expect(rightClick(document.getElementById("c")!)).toBe(true);
    });
  });
});
