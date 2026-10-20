/**
 * The views `show_ui` draws in another app's conversation, as an MCP App: the
 * page `roer mcp` serves as `ui://roer/view`. Each `show_ui` call is a page of
 * its own; its result carries every message of the surfaces it touched, so it
 * draws them whole, with the renderer Roer's panel uses. A click goes into the
 * conversation as the person's next message, and to `roer mcp` for
 * `read_ui_actions`.
 */
import { useState } from "react";
import type { Root } from "react-dom/client";

import { applyAll, applyMessage } from "../generative-ui/apply";
import { GenerativeSurface, type ResolvedEvent } from "../generative-ui/GenerativeSurface";
import { A2UI_VERSION, type A2uiMessage, type ComponentId, type JsonPointer, type RenderState } from "../generative-ui/schema";
import { on, open, request, resized, say, type HostContext } from "./bridge";

/** Tells the app how tall the view is, whenever that changes: a view is as tall as what it holds. */
function followHeight() {
  const report = () => resized(document.documentElement.clientWidth, document.documentElement.scrollHeight);
  new ResizeObserver(report).observe(document.body);
  report();
}

const theme = (context?: HostContext) => {
  if (context?.theme) document.documentElement.dataset.theme = context.theme;
};

function Views({ initial }: { initial: RenderState }) {
  const [state, setState] = useState(initial);
  const [sent, setSent] = useState<string | null>(null);

  const setValue = (surfaceId: string) => (path: JsonPointer, value: unknown) =>
    setState((now) => applyMessage(now, { version: A2UI_VERSION, updateDataModel: { surfaceId, path, value } }));

  const act = (surfaceId: string) => (event: ResolvedEvent, sourceComponentId: ComponentId) => {
    const message = {
      version: A2UI_VERSION,
      action: {
        name: event.name,
        surfaceId,
        sourceComponentId,
        timestamp: new Date().toISOString(),
        context: event.context,
        ...(event.userMessage ? { userMessage: event.userMessage } : {}),
      },
    };
    const dataModel = state.surfaces[surfaceId]?.sendDataModel ? state.dataModels[surfaceId] : undefined;
    void request("tools/call", { name: "roer_view_action", arguments: { message, ...(dataModel ? { dataModel } : {}) } }).catch(() => undefined);
    const details = Object.keys(event.context).length > 0 ? `\n${JSON.stringify(event.context)}` : "";
    say(`${event.userMessage ?? `Clicked “${event.name}” in the view ${surfaceId}.`}${details}`).then(
      () => setSent(`Sent “${event.name}” to the conversation.`),
      () => setSent(`Could not send “${event.name}”.`),
    );
  };

  const ids = Object.keys(state.surfaces);
  if (ids.length === 0) return <p className="gen-text muted mcp-message">Nothing to show: the view was closed.</p>;
  return (
    <div className="gen-tab mcp-view">
      {ids.map((id) => (
        <GenerativeSurface
          key={id}
          surface={state.surfaces[id]}
          dataModel={state.dataModels[id] ?? {}}
          onSetValue={setValue(id)}
          onAction={act(id)}
        />
      ))}
      {sent ? <p className="gen-result">{sent}</p> : null}
    </div>
  );
}

export async function runView(root: Root) {
  document.documentElement.classList.add("mcp-view-page");
  // The result comes after the handshake; hear it before it can arrive.
  on("ui/notifications/tool-result", (result) => {
    const messages = (result?.structuredContent?.messages ?? []) as A2uiMessage[];
    root.render(<Views key={Date.now()} initial={applyAll(messages)} />);
  });
  on("ui/notifications/host-context-changed", theme);
  root.render(<p className="gen-text muted mcp-message">Drawing…</p>);
  const opened = await open();
  theme(opened.context);
  followHeight();
}
