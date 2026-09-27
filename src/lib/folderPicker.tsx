/**
 * A directory picker that works the same way whether Roer is a native
 * window or a browser tab.
 *
 * Native gets a real OS picker from `@tauri-apps/plugin-dialog`. A browser
 * tab has nothing like it — the File System Access API only ever hands back
 * an opaque handle, never the absolute path the backend needs to open a
 * project — so there this renders a small in-page browser instead, backed by
 * the server's `fs_list_dir`.
 */
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "radix-ui";

import { invoke } from "./backend";

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

interface DirEntry {
  name: string;
  path: string;
}

interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

function FolderBrowser({
  onPick,
  onCancel,
}: {
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (path?: string) => {
    invoke<DirListing>("fs_list_dir", { path })
      .then((next) => {
        setListing(next);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    load();
    // Runs once, to open on the starting directory (the home directory).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (result: string | null) => {
    setOpen(false);
    if (result) onPick(result);
    else onCancel();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-popover p-4 text-popover-foreground shadow-lg">
          <Dialog.Title className="mb-2 text-sm font-medium">Choose a folder</Dialog.Title>
          <div className="mb-3 truncate rounded border px-2 py-1 text-xs text-muted-foreground">
            {listing?.path ?? "…"}
          </div>
          {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
          <div className="mb-3 max-h-64 overflow-y-auto rounded border">
            {listing?.parent != null && (
              <button
                type="button"
                className="block w-full px-2 py-1 text-left text-sm hover:bg-accent"
                onClick={() => load(listing.parent ?? undefined)}
              >
                ..
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="block w-full px-2 py-1 text-left text-sm hover:bg-accent"
                onClick={() => load(entry.path)}
              >
                {entry.name}
              </button>
            ))}
            {listing && listing.entries.length === 0 && (
              <div className="px-2 py-1 text-sm text-muted-foreground">No subfolders</div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => close(null)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={!listing} onClick={() => close(listing?.path ?? null)}>
              Choose this folder
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Mounts the browser-mode picker in its own root, resolving once it closes. */
function pickFolderInBrowser(): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const cleanup = () => {
      root.unmount();
      host.remove();
    };
    root.render(
      <FolderBrowser
        onPick={(path) => {
          cleanup();
          resolve(path);
        }}
        onCancel={() => {
          cleanup();
          resolve(null);
        }}
      />,
    );
  });
}

/** A single directory, or `null` if the picker was dismissed. */
export async function pickFolder(): Promise<string | null> {
  if (inTauri()) {
    const picked = await openNativeDialog({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  }
  return pickFolderInBrowser();
}
