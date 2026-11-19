/**
 * A view an agent answered a thread with, drawn in the thread under its words: the same catalog as the side panel's,
 * so the answer to a comment is in one place. What the person types in it stays here; a button they press goes back
 * to the agent as their reply in the thread.
 */
import { useEffect, useMemo, useState } from "react";

import { applyAll } from "./generative-ui/apply";
import { GenerativeSurface, type ResolvedEvent } from "./generative-ui/GenerativeSurface";
import { isA2uiMessage, writePointer, type DataModel } from "./generative-ui/schema";

/** A pressed button, as the person's reply says it: which one, its event, and what it carried. */
export function pressedText(event: ResolvedEvent, component: string): string {
  const context = Object.keys(event.context ?? {}).length > 0 ? `\n\n\`\`\`json\n${JSON.stringify(event.context, null, 2)}\n\`\`\`` : "";
  return `Pressed \`${component}\` in your view: event \`${event.name}\`.${context}`;
}

export function ThreadView({
  messages,
  onPress,
  onOpenFile,
}: {
  messages: readonly unknown[];
  /** A button in it was pressed. */
  onPress: (event: ResolvedEvent, component: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  // Only what is well formed reaches the reducer: the messages are an agent's, kept as it sent them.
  // Keyed on what the messages say, not the array: the threads are read again on every change to any of them, and
  // a view would otherwise start over, losing what was typed in it, whenever another thread got an answer.
  const key = JSON.stringify(messages);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => applyAll(messages.filter(isA2uiMessage)), [key]);
  const id = Object.keys(state.surfaces)[0];
  const surface = id ? state.surfaces[id] : undefined;
  const sent = id ? state.dataModels[id] : undefined;
  const [model, setModel] = useState<DataModel>(sent ?? {});
  // A view sent again starts from its own data.
  useEffect(() => setModel(sent ?? {}), [sent]);

  if (!surface) return <p className="muted thread-view-empty">[a view that could not be drawn]</p>;
  return (
    <div
      className="thread-view"
      role="group"
      aria-label="The agent's view"
      // Typing in its fields is the field's: the diff or file around it steps on the arrows, and R replies.
      onKeyDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) event.stopPropagation();
      }}
    >
      <GenerativeSurface
        surface={surface}
        dataModel={model}
        onSetValue={(path, value) => setModel((current) => writePointer(current, path, value))}
        onAction={onPress}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}
