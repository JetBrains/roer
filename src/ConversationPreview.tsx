import { X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { marked } from "./lib/marks";
import { Markdown } from "./Markdown";
import { readClaudeTranscript, type ClaudeMessage, type ClaudeSession, type ClaudeTranscript } from "./lib/pty";
import { relativeAge, shorten } from "./SessionBrowser";

/** How long the selection rests on a row before its transcript is read, so
 * the arrows can run down the list without reading each one on the way. */
const READ_DEBOUNCE_MS = 100;

/** How often the conversation shown is read again, for one still going on
 * elsewhere: only what was added since is read, and sent only if anything was. */
const READ_AGAIN_MS = 1500;

/** How near the end the list can be scrolled and still count as at it. */
const AT_END_PX = 24;

/** `next`, with the messages `previous` already had kept as they were, so
 * the ones on screen do not render again for each one added. */
function keep(previous: ClaudeTranscript | null, next: ClaudeTranscript): ClaudeTranscript {
  if (!previous) return next;
  const had = new Map(previous.messages.map((message) => [`${message.role}\0${message.at ?? ""}\0${message.text}`, message]));
  return {
    ...next,
    messages: next.messages.map((message) => had.get(`${message.role}\0${message.at ?? ""}\0${message.text}`) ?? message),
  };
}

/** The agents whose transcripts Roer can read. */
const READABLE = new Set(["claude", "codex", "pi", "junie"]);

/** Whether Roer can read this conversation's transcript. */
export const readable = (conversation: ClaudeSession) => READABLE.has(conversation.agent ?? "claude");

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
  /** Running in one of Roer's panes: opened rather than resumed, and nothing is started either way. */
  live?: boolean;
  onResume: (conversation: ClaudeSession) => void;
  onClose: () => void;
}

/**
 * A past conversation's prompts and replies, read from its transcript, to
 * tell it from the others before resuming one: resuming starts the CLI, and
 * with it its hooks and MCP servers, and moves the conversation to the top.
 * It opens where the conversation left off or, with a filter on, at the
 * first message the filter's words are in. A conversation still going on
 * elsewhere goes on here too: what it adds shows as it is written, and the
 * list follows it while it is scrolled to the end. A reply shows once it is
 * finished, as that is when the CLI writes it.
 */
export function ConversationPreview({
  conversation,
  cwds,
  terms,
  where,
  home,
  live = false,
  onResume,
  onClose,
}: ConversationPreviewProps) {
  const [read, setRead] = useState<{ id: string; transcript: ClaudeTranscript | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  /** The conversation and filter the list was last put in place for; after that, what is added only follows. */
  const placed = useRef<string | null>(null);
  const atEnd = useRef(true);
  const id = conversation && readable(conversation) ? conversation.id : undefined;
  const cwdsKey = cwds.join("\n");

  useEffect(() => {
    if (!id) return;
    let current = true;
    /** The `read` of the last answer, until the transcript is gone or not found. */
    let seen: number | undefined;
    let timer: number;
    setFailed(null);
    const readIt = () => {
      // Not while the window is out of sight: nobody is reading it.
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(readIt, READ_AGAIN_MS);
        return;
      }
      const first = seen === undefined;
      readClaudeTranscript(cwdsKey ? cwdsKey.split("\n") : [], id, seen)
        .then((next) => {
          if (!current) return;
          if (!next) {
            seen = undefined;
            setRead((was) => (was?.id === id && was.transcript === null ? was : { id, transcript: null }));
          } else if (!next.unchanged) {
            seen = next.read;
            setRead((was) => ({ id, transcript: keep(was?.id === id ? was.transcript : null, next) }));
          }
          timer = window.setTimeout(readIt, READ_AGAIN_MS);
        })
        .catch((cause: unknown) => {
          if (!current) return;
          // A read that failed once it was on screen leaves it there and tries again.
          if (first) setFailed(String(cause));
          else timer = window.setTimeout(readIt, READ_AGAIN_MS);
        });
    };
    timer = window.setTimeout(readIt, READ_DEBOUNCE_MS);
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
  // Read again, it moves only to follow what was added, and only from the end.
  const place = `${id ?? ""}\0${terms.join(" ")}`;
  useEffect(() => {
    const messages = list.current;
    if (!messages) return;
    if (placed.current === place) {
      if (atEnd.current) messages.scrollTo?.({ top: messages.scrollHeight });
      return;
    }
    placed.current = place;
    const at = messages.querySelector<HTMLElement>("[data-first-match]");
    atEnd.current = !at;
    messages.scrollTo?.({
      top: at ? at.offsetTop - (messages.clientHeight - at.offsetHeight) / 2 : messages.scrollHeight,
    });
  }, [transcript, matchAt, place]);

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
              {live ? "Open" : "Resume"}
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
        {live
          ? "Running in Roer: what it says shows here as it is written, a reply once it is finished."
          : "Read-only: nothing runs while you read, so no hooks or MCP servers start."}
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
        <ol
          className="conversation-messages"
          ref={list}
          onScroll={(event) => {
            const messages = event.currentTarget;
            atEnd.current = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= AT_END_PX;
          }}
        >
          {transcript.earlier > 0 ? (
            <li className="conversation-earlier muted">
              {transcript.earlier} earlier {transcript.earlier === 1 ? "message" : "messages"} not shown
            </li>
          ) : null}
          {transcript.messages.map((message, index) => (
            <Said
              // Its place in the whole conversation, which stays its own as the window moves on.
              key={transcript.earlier + index}
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
