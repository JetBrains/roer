/**
 * The "plan review before execution" ADLC scenario from the research draft,
 * wired end to end: messages -> the same reducer a real drafting call feeds
 * -> the trusted renderer -> a result an agent would read back.
 *
 * State lives in the parent (`App`), because the live bridge needs to reach
 * it from outside a render: a `roer plugin-ui` message arrives as a Tauri
 * event, not a prop, and has to update the same reducer a checkbox flip does.
 * This component owns only the one piece of state nothing outside it cares
 * about — the approve/cancel result banner.
 */
import { useState } from "react";

import { applyMessage } from "./apply";
import { GenerativeSurface } from "./GenerativeSurface";
import type { A2uiMessage, RenderState } from "./schema";
import { writePath } from "./schema";

interface Props {
  state: RenderState;
  surfaceId: string;
  onChange: (state: RenderState) => void;
  /** The messages that produced `state`, for the raw-wire debug view. */
  log: readonly A2uiMessage[];
  /** False while showing the built-in fixture; true once a real message has
   * arrived over the bridge. */
  live: boolean;
}

export function GenerativeUITab({ state, surfaceId, onChange, log, live }: Props) {
  const [result, setResult] = useState<string | null>(null);

  const surface = state.surfaces[surfaceId];
  const dataModel = state.dataModels[surfaceId] ?? {};

  const handleToggle = (path: string, value: boolean) => {
    // A checkbox flip becomes the same message shape a server-authored
    // update would send — proving the renderer only ever reacts to messages,
    // never to a shortcut path around them.
    onChange(
      applyMessage(state, {
        kind: "dataModelUpdate",
        surfaceId,
        patch: writePath({}, path, value),
      }),
    );
    setResult(null);
  };

  const handleAction = (action: string) => {
    if (action === "approve") {
      const chosen = Object.entries((dataModel.changes as Record<string, boolean>) ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id);
      setResult(
        chosen.length > 0
          ? `Approved: ${chosen.join(", ")}`
          : "Approved, but nothing was checked — nothing to apply.",
      );
    } else {
      setResult("Cancelled. Nothing was applied.");
    }
  };

  return (
    <div className="gen-tab">
      {!live ? (
        <p className="gen-text muted">
          Showing the built-in fixture. Ask an agent in this session's terminal to build a plugin
          UI to replace it live.
        </p>
      ) : null}

      {surface ? (
        <GenerativeSurface
          surface={surface}
          dataModel={dataModel}
          onToggle={handleToggle}
          onAction={handleAction}
        />
      ) : (
        <p className="gen-text muted">No surface yet.</p>
      )}

      {result ? <p className="gen-result">{result}</p> : null}

      <details className="gen-wire">
        <summary>Raw A2UI-shaped messages behind this surface</summary>
        <pre>{JSON.stringify(log, null, 2)}</pre>
      </details>
    </div>
  );
}
