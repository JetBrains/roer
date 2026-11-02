/**
 * `loadData` in Roer's panel: a message that fills a data-model path from a
 * file or a git read (`genui_load.rs` decides which), so an agent names where
 * data comes from instead of writing it out. Given `every`, the panel reads it
 * again on its own that often and writes the path only when it changed, until
 * the surface is gone or the stage moves to another session: a work item an
 * agent keeps calling `work-item__show` on, a branch's `git diff`.
 *
 * Roer's addition to A2UI v1.0, the same message the roer-ui mod for Claude
 * Code takes (claude-plugin/roer-ui).
 */
import { useCallback, useEffect, useRef } from "react";

import { invoke } from "../lib/backend";
import { A2UI_VERSION, readPointer } from "./schema";

/** The shortest and longest wait between two reads of a live load, in seconds. */
export const LIVE_EVERY = { min: 1, max: 3600 } as const;
/** How many live loads the panel keeps at once. */
export const LIVE_MAX = 8;

export interface PanelLoad {
  surfaceId: string;
  path: string;
  as: "text" | "json";
  /** A JSON pointer into what a `json` load read: only that part fills `path`. */
  pick?: string;
  /** Seconds between reads of a live load. */
  every?: number;
  /** `git <subcommand> …`, run in the session's repository. */
  run?: string[];
  /** A file under the session's repository or Roer's folder; `~/` is the home folder. */
  file?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `loadData` message read as a load, or why it is malformed; undefined for any other message. */
export function readLoadData(message: unknown): PanelLoad | string | undefined {
  if (!isRecord(message) || !("loadData" in message)) return undefined;
  if (message.version !== A2UI_VERSION) return `version is ${JSON.stringify(message.version)}, not "${A2UI_VERSION}"`;
  if (Object.keys(message).length !== 2) return "a loadData message carries nothing else";
  const wire = message.loadData;
  if (!isRecord(wire)) return "loadData is not an object";
  const { surfaceId, path, as = "text", pick, every, run, file } = wire;
  if (typeof surfaceId !== "string" || surfaceId === "") return "a load needs a surfaceId";
  if (typeof path !== "string") return "a load needs a path";
  if (as !== "text" && as !== "json") return `a load's as is ${JSON.stringify(as)}, not "text" or "json"`;
  if ((run === undefined) === (file === undefined)) return "a load reads exactly one of run, file";
  if (run !== undefined && (!Array.isArray(run) || run.length === 0 || !run.every((arg) => typeof arg === "string"))) {
    return "a load's run is a non-empty list of strings";
  }
  if (file !== undefined && (typeof file !== "string" || file === "")) return "a load's file is a path";
  if (pick !== undefined && (typeof pick !== "string" || (pick !== "" && !pick.startsWith("/")))) {
    return 'a load\'s pick is a JSON pointer ("" or starting with /)';
  }
  if (pick !== undefined && as !== "json") return 'a load picks from JSON: give it as: "json"';
  if (
    every !== undefined &&
    (typeof every !== "number" || !Number.isFinite(every) || every < LIVE_EVERY.min || every > LIVE_EVERY.max)
  ) {
    return `a load's every is seconds, from ${LIVE_EVERY.min} to ${LIVE_EVERY.max}`;
  }
  return {
    surfaceId,
    path,
    as,
    ...(typeof pick === "string" ? { pick } : {}),
    ...(typeof every === "number" ? { every } : {}),
    ...(run !== undefined ? { run: run as string[] } : { file: file as string }),
  };
}

/** What a load names, for an error a person reads. */
export const describeLoad = (load: PanelLoad): string => (load.run ? `\`${load.run.join(" ")}\`` : (load.file ?? ""));

/** What a load read, as the load asked for it: text, JSON, or one part of the JSON. */
export function parseLoaded(load: PanelLoad, text: string): { value: unknown } | { error: string } {
  if (load.as === "text") return { value: text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${describeLoad(load)} is not JSON` };
  }
  if (load.pick === undefined || load.pick === "") return { value };
  // Nothing there yet is a value too, so a surface bound to an item still to be written says so.
  return { value: readPointer(value, load.pick) ?? null };
}

/** Reads `load` for the session whose repository is `cwd`. Never throws. */
export async function fetchPanelLoad(load: PanelLoad, cwd: string): Promise<{ value: unknown } | { error: string }> {
  try {
    const text = await invoke<string>("genui_load", { cwd, run: load.run ?? null, file: load.file ?? null });
    return parseLoaded(load, text);
  } catch (cause) {
    return { error: `${describeLoad(load)}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

const keyOf = (load: { surfaceId: string; path: string }) => `${load.surfaceId}\u0000${load.path}`;

interface Live {
  load: PanelLoad & { every: number };
  cwd: string;
  /** When it was last read, in ms. */
  at: number;
  /** What it last wrote, as JSON, so an unchanged read writes nothing. */
  last: string;
}

/**
 * Runs loads for the panel and keeps the live ones going. `write` puts a value at a load's path; `has` says
 * whether its surface is still on screen. Every live load stops when `session` changes: they read the repository
 * of the session they were sent for.
 */
export function useLiveLoads(
  write: (load: PanelLoad, value: unknown) => void,
  has: (surfaceId: string) => boolean,
  session: string | undefined,
) {
  const live = useRef(new Map<string, Live>());
  const writeRef = useRef(write);
  writeRef.current = write;
  const hasRef = useRef(has);
  hasRef.current = has;

  useEffect(() => {
    live.current.clear();
  }, [session]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const [key, one] of live.current) {
        if (!hasRef.current(one.load.surfaceId)) {
          live.current.delete(key);
          continue;
        }
        if (now - one.at < one.load.every * 1000) continue;
        one.at = now;
        void fetchPanelLoad(one.load, one.cwd).then((got) => {
          // Dropped meanwhile, or failed: the last good value stays.
          if (live.current.get(key) !== one || "error" in got) return;
          const json = JSON.stringify(got.value);
          if (json === one.last) return;
          one.last = json;
          writeRef.current(one.load, got.value);
        });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  /** Runs `load` once and writes it; given `every`, keeps it live. Resolves to an error a person reads, or null. */
  const run = useCallback(async (load: PanelLoad, cwd: string): Promise<string | null> => {
    const got = await fetchPanelLoad(load, cwd);
    if ("error" in got) return got.error;
    writeRef.current(load, got.value);
    if (load.every === undefined) return null;
    const key = keyOf(load);
    if (!live.current.has(key) && live.current.size >= LIVE_MAX) return `the panel keeps ${LIVE_MAX} live loads at most`;
    live.current.set(key, { load: { ...load, every: load.every }, cwd, at: Date.now(), last: JSON.stringify(got.value) });
    return null;
  }, []);

  /** A surface created again starts with no live loads: the message that made it brings its own. */
  const forget = useCallback((surfaceId: string) => {
    for (const [key, one] of live.current) if (one.load.surfaceId === surfaceId) live.current.delete(key);
  }, []);

  return { run, forget };
}
