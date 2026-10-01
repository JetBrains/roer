/**
 * A system notification, the same way whether Roer is a native window or a
 * browser tab.
 *
 * Native goes through the notification plugin, called directly rather than
 * through `./backend`, which would send it to `roer-server` from a browser
 * tab. A browser tab has the Notification API of its own, which can also say
 * when one is clicked; the native one cannot, so there a click only brings
 * Roer to the front.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const KEY = "roer:notifications";

/** On unless turned off from the title bar. */
export function notificationsOn(): boolean {
  return localStorage.getItem(KEY) !== "off";
}

/** The user's choice, persisted. */
export function useNotificationsOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(notificationsOn);
  useEffect(() => {
    localStorage.setItem(KEY, on ? "on" : "off");
  }, [on]);
  return [on, setOn];
}

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** Asked once, the first time there is something to say. */
let allowed: Promise<boolean> | null = null;

async function ask(): Promise<boolean> {
  if (inTauri()) {
    if (await invoke<boolean | null>("plugin:notification|is_permission_granted")) return true;
    return (await invoke<string>("plugin:notification|request_permission")) === "granted";
  }
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/** Shows `title` and `body`, unless notifications are turned off or not
 * allowed. Never throws: a notification that could not be shown is only one
 * fewer. Turned off, the system is not even asked for permission. */
export async function notify(title: string, body: string, onClick?: () => void): Promise<void> {
  if (!notificationsOn()) return;
  try {
    allowed ??= ask().catch(() => false);
    if (!(await allowed)) return;
    if (inTauri()) {
      await invoke("plugin:notification|notify", { options: { title, body } });
      return;
    }
    const shown = new Notification(title, { body });
    shown.onclick = () => {
      window.focus();
      onClick?.();
      shown.close();
    };
  } catch {
    /* not shown */
  }
}
