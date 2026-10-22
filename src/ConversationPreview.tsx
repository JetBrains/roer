import { X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { marked } from "./lib/marks";
import { Markdown } from "./Markdown";
import { readClaudeTranscript, type ClaudeMessage, type ClaudeSession, type ClaudeTranscript } from "./lib/pty";
import { relativeAge, shorten } from "./SessionBrowser";

/** How long the selection rests on a row before its transcript is read, so
 * the arrows can run down the list without reading each one on the way. */
const READ_DEBOUNCE_MS = 100;

/** Whether Roer can read this conversation's transcript: only Claude Code's
 * are, so far. */
export const readable = (conversation: ClaudeSession) => (conversation.agent ?? "claude") === "claude";

export interface ConversationPreviewProps {
  /** The conversation to read; `null` before one is picked. */
  conversation: ClaudeSession | null;
  /** Where conversations are looked for, which is where it is found. */
  cwds: string[];
  /** The filter's words, lower case, to go to and mark. */
  terms: string[];
  /** Its branch, or its worktree's folder, as its row says it. */
  where?: string;
  home: string | undefined;
  onResume: (conversation: ClaudeSession) => void;
  onClose: () => void;
}

/**
 * A past conversation's prompts and replies, read from its transcript, to
 * tell it from the others before resuming one: resuming starts the CLI, and
 * with it its hooks and MCP servers, and moves the conversation to the top.
 * It opens where the conversation left off or, with a filter on, at the
 * first message the filter's words are in.
 */
export function ConversationPreview({
  conversation,
  cwds,
  terms,
  where,
  home,
  onResume,
  onClose,
}: ConversationPreviewProps) {
  const [read, setRead] = useState<{ id: string; transcript: ClaudeTranscript | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const id = conversation && readable(conversation) ? conversation.id : undefined;
  const cwdsKey = cwds.join("\n");

  useEffect(() => {
    if (!id) return;
    let current = true;
    setFailed(null);
    const timer = window.setTimeout(() => {
      readClaudeTranscript(cwdsKey ? cwdsKey.split("\n") : [], id)
        .then((transcript) => {
          if (current) setRead({ id, transcript });
        })
        .catch((cause: unknown) => {
          if (current) setFailed(String(cause));
        });
    }, READ_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [id, cwdsKey]);

  const transcript = read && read.id === id ? read.transcript : undefined;
  const matchAt =
    transcript && terms.length > 0
      ? transcript.messages.findIndex((message) => terms.some((term) => message.text.toLowerCase().includes(term)))
      : -1;

  // The panel's own list scrolls, the page stays put: to the first match,
  // in the middle; with none, to the end, where the conversation left off.
  useEffect(() => {
    const messages = list.current;
    if (!messages) return;
    const at = messages.querySelector<HTMLElement>("[data-first-match]");
    messages.scrollTo?.({
      top: at ? at.offsetTop - (messages.clientHeight - at.offsetHeight) / 2 : messages.scrollHeight,
    });
  }, [transcript, matchAt]);

  return (
    <aside
      className="conversation-preview"
      aria-label="Preview"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header>
        {conversation ? (
          <>
            <div className="conversation-preview-title">
              <h3>{conversation.title}</h3>
              <span className="muted">
                {[where, relativeAge(conversation.updatedAt), shorten(conversation.cwd, home)].filter(Boolean).join(" · ")}
              </span>
            </div>
            <button type="button" className="primary" onClick={() => onResume(conversation)}>
              Resume
            </button>
          </>
        ) : (
          <div className="conversation-preview-title">
            <h3>Preview</h3>
          </div>
        )}
        <button type="button" className="tree-action" aria-label="Close the preview" title="Close the preview (Esc)" onClick={onClose}>
          <X size={13} aria-hidden="true" />
        </button>
      </header>
      <p className="conversation-preview-note muted">
        Read-only: nothing runs while you read, so no hooks or MCP servers start.
      </p>
      {!conversation ? (
        <p className="muted">Pick a conversation to read it here.</p>
      ) : !readable(conversation) ? (
        <p className="muted">Roer can't read {conversation.agent} conversations yet; Resume opens it.</p>
      ) : failed ? (
        <p className="muted">Could not read it: {failed}</p>
      ) : transcript === undefined ? (
        <p className="muted">Reading…</p>
      ) : transcript === null ? (
        <p className="muted">There is nothing to show for this one.</p>
      ) : (
        <ol className="conversation-messages" ref={list}>
          {transcript.earlier > 0 ? (
            <li className="conversation-earlier muted">
              {transcript.earlier} earlier {transcript.earlier === 1 ? "message" : "messages"} not shown
            </li>
          ) : null}
          {transcript.messages.map((message, index) => (
            <Said
              key={index}
              message={message}
              agent={conversation.agent ?? "claude"}
              terms={terms}
              first={index === matchAt}
            />
          ))}
        </ol>
      )}
    </aside>
  );
}

/** One prompt or reply. Kept from rendering again while it and the words to
 * mark stay the same: the list beside it renders on every keystroke. */
const Said = memo(function Said({
  message,
  agent,
  terms,
  first,
}: {
  message: ClaudeMessage;
  agent: string;
  terms: string[];
  first: boolean;
}) {
  return (
    <li
      data-first-match={first ? "" : undefined}
      className={message.role === "user" ? "conversation-message user" : "conversation-message"}
    >
      <span className="conversation-message-who">{message.role === "user" ? "You" : agent}</span>
      {/* A reply as the Markdown it was written in; what was typed as
          typed, since it is often pasted text Markdown would misread. */}
      {message.role === "assistant" ? (
        <Markdown className="file-markdown conversation-message-md" marks={terms} images={false}>
          {message.text}
        </Markdown>
      ) : (
        <div className="conversation-message-text">{terms.length > 0 ? marked(message.text, terms) : message.text}</div>
      )}
    </li>
  );
});
