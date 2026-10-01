/**
 * A yes/no question before something that cannot be taken back. Native gets
 * the OS sheet from `@tauri-apps/plugin-dialog`; a browser tab, which has no
 * such plugin behind it, gets the browser's own `confirm`.
 */
import { ask } from "@tauri-apps/plugin-dialog";

export async function confirmAction(message: string, title: string): Promise<boolean> {
  if ("__TAURI_INTERNALS__" in window) return ask(message, { title, kind: "warning" });
  return window.confirm(message);
}
