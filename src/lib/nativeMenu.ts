/**
 * Keeps the webview's own right-click menu (Reload, Inspect Element, Back)
 * shut in Roer's window. Nothing in it belongs to Roer, and over a terminal
 * it opens on top of tmux's pane menu. Roer's own menus are React's, which
 * have handled the event before it bubbles up to the window.
 *
 * Text fields keep it, for spelling suggestions and paste, except xterm's
 * hidden textarea, which a right-click on the terminal can land on.
 *
 * Only inside Tauri: a Roer page open in a browser keeps the browser's menu.
 */
export function shutNativeMenu(target: Window = window): () => void {
  if (!("__TAURI_INTERNALS__" in target)) return () => {};
  const onMenu = (event: MouseEvent) => {
    if (!event.defaultPrevented && !keepsMenu(event.target)) event.preventDefault();
  };
  target.addEventListener("contextmenu", onMenu);
  return () => target.removeEventListener("contextmenu", onMenu);
}

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "password", "tel", "number", ""]);

function keepsMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest(".xterm")) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.getAttribute("type")?.toLowerCase() ?? "");
  return target instanceof HTMLElement && target.isContentEditable;
}
