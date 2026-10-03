/**
 * The extensions that are loaded and what they put on screen.
 *
 * A load is atomic: the new activation runs against a fresh set of
 * registrations, and only once it has returned are the old ones disposed and
 * the new ones swapped in. An activation that throws leaves the previous
 * version live, which is what lets an agent save a broken file without the
 * person's tab going blank.
 */
import { useSyncExternalStore } from "react";

import type { Extension, Roer, TabOptions, ToolOptions } from "./api";
import { rpcCall } from "./rpc";

export interface StageTabEntry extends Required<Omit<TabOptions, "id">> {
  /** The tab's id in the stage's tab model. */
  tabId: string;
  /** Which load registered it: a reload is a new one, and starts the tab over. */
  generation: number;
  extension: string;
  id: string;
}

export interface ToolEntry extends ToolOptions {
  extension: string;
}

interface Loaded {
  tabs: StageTabEntry[];
  tools: ToolEntry[];
  /** By tab id. Kept with the load, so a reload swaps them with its tabs. */
  badges: Map<string, string>;
  /** Run last first on unload. */
  disposers: Array<() => void>;
}

/**
 * A bundled extension's tab keeps its plain id ("changes"), which the rest of
 * the app and its shortcuts already know it by. Anyone else's is namespaced.
 */
export const extensionTabId = (extension: string, tab: string, bundled: boolean): string =>
  bundled ? tab : `ext:${extension}/${tab}`;

export class Registry {
  private loaded = new Map<string, Loaded>();
  private listeners = new Set<() => void>();
  private tabsCache: readonly StageTabEntry[] = [];
  private badgesCache: ReadonlyMap<string, string> = new Map();
  private toolsCache: readonly ToolEntry[] = [];
  private generation = 0;

  /** Activates `extension` as `id`, replacing what was loaded under it. Throws what the activation threw. */
  load(id: string, extension: Extension, options: { bundled?: boolean } = {}): void {
    const next: Loaded = { tabs: [], tools: [], badges: new Map(), disposers: [] };
    const generation = ++this.generation;
    const roer: Roer = {
      id,
      stage: {
        registerTab: (tab) => {
          const entry: StageTabEntry = {
            tabId: extensionTabId(id, tab.id, options.bundled ?? false),
            generation,
            extension: id,
            id: tab.id,
            title: tab.title,
            component: tab.component,
            order: tab.order ?? 100,
            needsSession: tab.needsSession ?? true,
            keepAcrossSessions: tab.keepAcrossSessions ?? false,
          };
          next.tabs.push(entry);
          // Registered during activation, it shows with the load; later, at once.
          if (this.loaded.get(id) === next) this.changed();
          const dispose = () => {
            next.tabs = next.tabs.filter((one) => one !== entry);
            next.badges.delete(entry.tabId);
            this.changed();
          };
          return dispose;
        },
      },
      badge: {
        set: (tab, text) => {
          const tabId = extensionTabId(id, tab, options.bundled ?? false);
          if (text === null) next.badges.delete(tabId);
          else next.badges.set(tabId, text);
          this.changed();
        },
      },
      rpc: {
        call: (method, params) => rpcCall(id, method, params),
      },
      tools: {
        register: (tool) => {
          const entry: ToolEntry = { ...tool, extension: id };
          next.tools.push(entry);
          // Registered during activation, it shows with the load; later, at once.
          if (this.loaded.get(id) === next) this.changed();
          return () => {
            next.tools = next.tools.filter((one) => one !== entry);
            this.changed();
          };
        },
      },
    };

    const cleanup = extension.activate(roer);
    if (typeof cleanup === "function") next.disposers.push(cleanup);

    this.dispose(id);
    this.loaded.set(id, next);
    this.changed();
  }

  unload(id: string): void {
    if (!this.loaded.has(id)) return;
    this.dispose(id);
    this.loaded.delete(id);
    this.changed();
  }

  has(id: string): boolean {
    return this.loaded.has(id);
  }

  /** Every tab, by `order`, then by extension and tab id so the strip never shuffles. */
  tabs(): readonly StageTabEntry[] {
    return this.tabsCache;
  }

  badgesByTab(): ReadonlyMap<string, string> {
    return this.badgesCache;
  }

  /** Every tool agents are offered, by extension, then name. */
  tools(): readonly ToolEntry[] {
    return this.toolsCache;
  }

  /** The loaded tool `name` of `extension`, if there is one. */
  tool(extension: string, name: string): ToolEntry | undefined {
    return this.loaded.get(extension)?.tools.find((tool) => tool.name === name);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private dispose(id: string): void {
    const old = this.loaded.get(id);
    if (!old) return;
    for (const dispose of [...old.disposers].reverse()) {
      try {
        dispose();
      } catch {
        // A cleanup that throws must not keep the new version from loading.
      }
    }
  }

  private changed(): void {
    this.tabsCache = [...this.loaded.values()]
      .flatMap((one) => one.tabs)
      .sort((a, b) => a.order - b.order || a.extension.localeCompare(b.extension) || a.id.localeCompare(b.id));
    this.badgesCache = new Map([...this.loaded.values()].flatMap((one) => [...one.badges]));
    this.toolsCache = [...this.loaded.values()]
      .flatMap((one) => one.tools)
      .sort((a, b) => a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name));
    for (const listener of this.listeners) listener();
  }
}

export const registry = new Registry();

export function useStageTabs(from: Registry = registry): readonly StageTabEntry[] {
  return useSyncExternalStore(from.subscribe, () => from.tabs());
}

export function useBadges(from: Registry = registry): ReadonlyMap<string, string> {
  return useSyncExternalStore(from.subscribe, () => from.badgesByTab());
}
