import { useEffect, useRef } from "react";

import { allShortcuts } from "./lib/keys";

/** Every keyboard shortcut on one sheet. `tabs` are the strip's, in order. */
export function ShortcutsDialog({ tabs, onClose }: { tabs?: readonly string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2>Keyboard shortcuts</h2>
        <dl>
          {allShortcuts(tabs).map(([what, keys]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
