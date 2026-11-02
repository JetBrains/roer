/**
 * A saved copy of a tab: the page "Save as HTML…" writes (see `protocol.ts`).
 * The same page records the copy, in a sandboxed frame of the view that saves
 * it, and plays it back, in the file; `window.__roerCopy` says which.
 *
 * It is Roer's host made small: React, the `roer` SDK and `roer/ui` from
 * `extensions/host.ts`, the bundled extensions, and the backend swapped for
 * `./backend`, so a tab's own code runs here unchanged.
 */
import { createRoot } from "react-dom/client";

import "../index.css";
import "./copy.css";
import type { Extension, Session } from "../extensions/api";
import { TabBody } from "../extensions/TabBody";
import { loadBundled } from "../extensions/bundled";
import { installHost } from "../extensions/host";
import { registry, type StageTabEntry } from "../extensions/registry";
import { loadSharedStorage, trackSharedReads } from "../lib/sharedStorage";
import { seenCalls, settled, tellParent } from "./backend";
import type { CopyBoot } from "./protocol";

const copy = globalThis.__roerCopy as CopyBoot;
document.documentElement.dataset.theme = copy.theme;
const root = createRoot(document.getElementById("root")!);

async function importText(js: string): Promise<{ default?: Extension }> {
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: Extension };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const notHere = () => Promise.reject(new Error("This is a saved copy: it can't do that."));

function Page({ entry, session }: { entry: StageTabEntry; session: Session | null }) {
  const saved = copy.savedAt ? new Date(copy.savedAt) : null;
  return (
    <div className="copy-page">
      {copy.mode === "replay" ? (
        <div className="copy-banner" role="note">
          <strong>{copy.title}</strong>
          {session?.root ? ` · ${session.root.replace(/\/+$/, "").split("/").pop()}` : ""}
          {session?.branch ? ` · ${session.branch}` : ""}
          <span className="copy-banner-note">
            A saved copy{saved ? `, ${saved.toLocaleString()}` : ""}: it shows what Roer showed then, and changes nothing.
          </span>
        </div>
      ) : null}
      <div className="copy-body ext-tab">
        <TabBody
          entry={entry}
          session={session}
          active
          openFile={() => undefined}
          activateTab={() => undefined}
        />
      </div>
    </div>
  );
}

async function main() {
  installHost();
  loadBundled();
  if (copy.js) {
    const module = await importText(copy.js);
    if (!module.default) throw new Error("the extension's app has no default export");
    registry.load(copy.extension, module.default);
    if (copy.css) {
      const style = document.createElement("style");
      style.textContent = copy.css;
      document.head.append(style);
    }
  }
  const entry = registry.tabs().find((tab) => tab.tabId === copy.tabId);
  if (!entry) throw new Error(`no tab ${copy.tabId} in this copy`);

  const read = new Set<string>();
  if (copy.mode === "record") trackSharedReads((key) => read.add(key));
  await loadSharedStorage();

  const session: Session | null = copy.session
    ? {
        // No pane: nothing in a copy types into a session, nor asks where one has gone.
        cwd: copy.session.cwd,
        root: copy.session.root,
        branch: copy.session.branch,
        agent: null,
        busy: false,
        changed: null,
        send: notHere,
      }
    : null;
  root.render(<Page entry={entry} session={session} />);

  if (copy.mode !== "record") return;
  // Drawn, and what it fetched on its own has come back: then what it would be clicked to, then that too.
  await settled();
  await entry.copy.prepare?.(seenCalls);
  await settled();
  tellParent({ type: "roer-copy:done", sharedRead: [...read] });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (copy.mode === "record") tellParent({ type: "roer-copy:failed", error: message });
  root.render(
    <div className="copy-page">
      <p className="error">{message}</p>
    </div>,
  );
});
