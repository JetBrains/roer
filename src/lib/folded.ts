import { useState } from "react";

/** How many folds are remembered per list. Old ones go first, so the keys
 * of worktrees and Projects long gone do not pile up. */
const KEPT = 200;

/**
 * Which groups of a list are folded, kept in this browser under `storageKey`
 * so a long list stays the way it was left. Each list has its own key: the
 * sidebar's tree and the Workspace tab fold apart. Storage that is not
 * there leaves everything open.
 */
export function useFolded(storageKey: string): [ReadonlySet<string>, (key: string) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      // A Set keeps the order keys went in, oldest first.
      const kept = [...next].slice(-KEPT);
      try {
        localStorage.setItem(storageKey, JSON.stringify(kept));
      } catch {
        /* kept for this run only */
      }
      return new Set(kept);
    });
  return [folded, toggle];
}
