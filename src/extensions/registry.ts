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

import type { Extension, Roer, TabOptions } from "./api";

export interface StageTabEntry extends Required<Omit<TabOptions, "id">> {
  /** The tab's id in the stage's tab model. */
  tabId: string;
  /** Which load registered it: a reload is a new one, and starts the tab over. */
  generation: number;
  extension: string;
  id: string;
}

interface Loaded {
  tabs: StageTabEntry[];
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
  private badges = new Map<string, string>();
  private listeners = new Set<() => void>();
  private tabsCache: readonly StageTabEntry[] = [];
  private badgesCache: ReadonlyMap<string, string> = new Map();
  private generation = 0;

  /** Activates `extension` as `id`, replacing what was loaded under it. Throws what the activation threw. */
  load(id: string, extension: Extension, options: { bundled?: boolean } = {}): void {
    const next: Loaded = { tabs: [], disposers: [] };
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
          const dispose = () => {
            next.tabs = next.tabs.filter((one) => one !== entry);
            this.badges.delete(entry.tabId);
            this.changed();
          };
          return dispose;
        },
      },
      badge: {
        set: (tab, text) => {
          const tabId = extensionTabId(id, tab, options.bundled ?? false);
          if (text === null) this.badges.delete(tabId);
          else this.badges.set(tabId, text);
          this.changed();
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private dispose(id: string): void {
    const old = this.loaded.get(id);
    if (!old) return;
    for (const tab of old.tabs) this.badges.delete(tab.tabId);
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
    this.badgesCache = new Map(this.badges);
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
