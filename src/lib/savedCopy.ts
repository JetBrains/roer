/**
 * "Save as HTML…": a tab as one HTML file that draws it without Roer, from the
 * answers it got while it was saved (see `src/copy/protocol.ts`).
 *
 * The tab runs in a hidden frame sandboxed to scripts alone: no access to this
 * view's storage, its backend or anything else of it. Everything the frame's
 * backend asks for comes here, and only reads (`readOnly`) are run; the rest
 * is refused before it runs and listed in the result. So saving a copy cannot
 * commit, merge, send to a session or start an agent, whatever the tab does.
 */
import { save } from "@tauri-apps/plugin-dialog";

import type { StageTabEntry } from "../extensions/registry";
import { inDesktop, invoke } from "./backend";
import { confirmAction } from "./confirm";
import { callKey, jsonText, readOnly, scriptText, type Answer, type CopyBoot, type CopySession, type FromFrame } from "../copy/protocol";
import { sharedStorage } from "./sharedStorage";
import { currentTheme } from "./theme";

/** How long a tab may take to draw and fetch what its copy holds. */
const SAVE_LIMIT_MS = 90000;

export interface SavedCopy {
  html: string;
  /** Commands the tab asked for that a copy does not run, each once. */
  refused: string[];
  /** Calls the copy holds. */
  answers: number;
}

interface Bundle {
  js: string;
  css: string;
}

/** The copy page's own build, served beside the app's (`vite.copy.config.ts`). */
async function runtime(): Promise<{ js: string; css: string }> {
  const [js, css] = await Promise.all(
    ["roer-copy/runtime.js", "roer-copy/runtime.css"].map(async (file) => {
      const res = await fetch(new URL(file, document.baseURI));
      if (!res.ok) throw new Error(`this Roer was built without the saved-copy page (${file}: ${res.status})`);
      return res.text();
    }),
  );
  return { js, css };
}

function page(title: string, css: string, js: string, boot: CopyBoot): string {
  return `<!doctype html>
<html lang="en" data-theme="${boot.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))} — saved from Roer</title>
<style>${css.replace(/<\/(style)/gi, "<\\/$1")}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="roer-copy">${jsonText(boot)}</script>
<script>window.__roerCopy = JSON.parse(document.getElementById("roer-copy").textContent);</script>
<script type="module">${scriptText(js)}</script>
</body>
</html>
`;
}

/**
 * What the saving view answers one call from the frame with. Only a read reaches `run`; anything else is refused
 * here, before it runs, and named in `refused`. `keep` is whether the copy holds the answer.
 */
export async function handleCall(
  cmd: string,
  args: Record<string, unknown>,
  readOnlyRpc: readonly string[],
  run: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
): Promise<{ answer: Answer; keep: boolean; refused?: string }> {
  if (cmd === "shared_state_all") {
    // The frame keeps only what the tab reads of it (`sharedRead`); the rest never leaves this view.
    const all = await run<Record<string, string>>("shared_state_all").catch(() => null);
    return { answer: { value: all ?? {} }, keep: false };
  }
  if (!readOnly(cmd, args, readOnlyRpc)) {
    return {
      answer: { error: "not while a copy is saved: only reads run then" },
      keep: false,
      refused: cmd === "extension_rpc" ? `server.ts ${String(args.method)}` : cmd,
    };
  }
  try {
    return { answer: { value: await run<unknown>(cmd, args) }, keep: true };
  } catch (cause) {
    return { answer: { error: cause instanceof Error ? cause.message : String(cause) }, keep: true };
  }
}

/** The branch arguments a kept call names: `branch`, `base`, `head`. */
const BRANCH_ARGS = ["branch", "base", "head"] as const;

/**
 * A repository's branch list, cut to the branches the copy shows: the session's and those its other calls compared
 * against. The rest of a person's branches (their names say what else they work on) stay out of the file, and a
 * copy's picker could not switch to them anyway.
 */
export function trimBranches(
  answers: Record<string, Answer>,
  kept: ReadonlyArray<{ cmd: string; args: Record<string, unknown> }>,
  session: CopySession | null,
): void {
  const named = new Set<string>(session?.branch ? [session.branch] : []);
  for (const { args } of kept) {
    for (const arg of BRANCH_ARGS) {
      const value = args[arg];
      if (typeof value === "string" && value) named.add(value.replace(/^origin\//, ""));
    }
  }
  for (const { cmd, args } of kept) {
    if (cmd !== "git_branches") continue;
    const key = callKey(cmd, args);
    const answer = answers[key];
    if (answer && "value" in answer && Array.isArray(answer.value)) {
      answers[key] = { value: answer.value.filter((name) => typeof name === "string" && named.has(name)) };
    }
  }
}

/** Saves `entry` as Roer shows it now, given `session`. */
export async function saveCopy(entry: StageTabEntry, session: CopySession | null): Promise<SavedCopy> {
  const { js, css } = await runtime();
  // A bundled tab is in the copy page already; anyone else's brings its own build.
  const own = entry.tabId.startsWith("ext:") ? await invoke<Bundle>("extension_bundle", { id: entry.extension }) : null;
  const base = {
    extension: entry.extension,
    tabId: entry.tabId,
    title: entry.title,
    session,
    theme: currentTheme(),
    ...(own ? { js: own.js, css: own.css } : {}),
  };

  const answers: Record<string, Answer> = {};
  const kept: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const refused = new Set<string>();
  const readOnlyRpc = entry.copy.readOnlyRpc ?? [];

  const frame = document.createElement("iframe");
  // Scripts, and nothing else: an opaque origin, so not this view's storage, cookies or backend.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Off screen, but laid out at a real size: a tab that measures itself draws as it would.
  Object.assign(frame.style, { position: "fixed", left: "-20000px", top: "0", width: "1280px", height: "800px", border: "0" });

  const done = new Promise<string[]>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("the tab took too long to draw")), SAVE_LIMIT_MS);
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    const answer = (id: number, value: Answer) =>
      frame.contentWindow?.postMessage({ type: "roer-copy:answer", id, answer: value }, "*");

    async function onMessage(event: MessageEvent<FromFrame>) {
      if (event.source !== frame.contentWindow) return;
      const message = event.data;
      if (message?.type === "roer-copy:done") {
        finish();
        resolve(message.sharedRead);
      } else if (message?.type === "roer-copy:failed") {
        finish();
        reject(new Error(message.error));
      } else if (message?.type === "roer-copy:invoke") {
        const { id, cmd, args } = message;
        const handled = await handleCall(cmd, args, readOnlyRpc, invoke);
        if (handled.refused) refused.add(handled.refused);
        if (handled.keep) {
          answers[callKey(cmd, args)] = handled.answer;
          kept.push({ cmd, args });
        }
        answer(id, handled.answer);
      }
    }
    window.addEventListener("message", onMessage);
  });

  frame.srcdoc = page(entry.title, css, js, { ...base, mode: "record" });
  document.body.append(frame);
  let sharedRead: string[];
  try {
    sharedRead = await done;
  } finally {
    frame.remove();
  }

  trimBranches(answers, kept, session);
  const shared: Record<string, string> = {};
  for (const key of sharedRead) {
    // Who the review was between is a pane and a session id of this machine: nothing to the copy's reader.
    if (key.startsWith("roer:review:roles:")) continue;
    const value = sharedStorage.getItem(key);
    if (value !== null) shared[key] = value;
  }
  const html = page(entry.title, css, js, {
    ...base,
    mode: "replay",
    answers,
    shared,
    savedAt: new Date().toISOString(),
  });
  return { html, refused: [...refused], answers: Object.keys(answers).length };
}

/** A file name for the copy: the tab, where it was, and the day. */
export function copyFileName(title: string, session: CopySession | null): string {
  const where = [session?.root?.replace(/\/+$/, "").split("/").pop(), session?.branch].filter(Boolean).join("-");
  const day = new Date().toISOString().slice(0, 10);
  return `${[title, where, day].filter(Boolean).join(" ").replace(/[^\w.-]+/g, "-")}.html`;
}

/** What a person is told before the file is written. */
export const COPY_WARNING =
  "The file holds what the tab shows (for Changes: the branch's code changes, review comments and pull request), " +
  "readable by anyone you give it to. Saving runs only reads: nothing is committed, sent or started.";

/**
 * The whole of "Save as HTML…": says what the file will hold, saves the copy, and writes it where the person
 * picks (Roer's window) or downloads it (a browser page). What to tell them after, or null when they stopped.
 */
export async function saveTabAsHtml(entry: StageTabEntry, session: CopySession | null): Promise<string | null> {
  if (!(await confirmAction(COPY_WARNING, `Save a copy of ${entry.title} as HTML?`))) return null;
  const name = copyFileName(entry.title, session);
  // Asked first, before the tab is drawn and its reads run: a person who closes the picker has nothing run.
  const path = inDesktop()
    ? await save({ title: `Save a copy of ${entry.title}`, defaultPath: name, filters: [{ name: "HTML", extensions: ["html"] }] })
    : name;
  if (!path) return null;
  const copy = await saveCopy(entry, session);
  if (inDesktop()) {
    await invoke("save_copy_file", { path, html: copy.html });
  } else {
    const url = URL.createObjectURL(new Blob([copy.html], { type: "text/html" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const size = `${(copy.html.length / 1024 / 1024).toFixed(1)} MB`;
  const where = inDesktop() ? `Saved to ${path}` : `Downloaded ${name}`;
  const skipped = copy.refused.length
    ? ` Not run, since a copy only reads: ${copy.refused.join(", ")}.`
    : "";
  return `${where} (${size}, ${copy.answers} answers).${skipped}`;
}
