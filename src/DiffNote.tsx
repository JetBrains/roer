/**
 * A note in a diff that is somebody's comment: who wrote it, what they said
 * and the replies under it, and, when the diff offers answers, the buttons
 * that settle it — accept, decline, or say in your own words what to do.
 *
 * The note's `state` is the owner's truth. A click is shown at once, but
 * only while `state` is still what it replaced, so the owner resending the
 * old note does not undo it and sending anything else wins — the same rule
 * a work item's findings follow.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Markdown } from "./Markdown";
import type { DiffNote, NoteAction } from "./lib/diff";

export type { NoteAction };
import { openUrl } from "./lib/github";
import { isMac } from "./lib/keys";


/** A note answered: `action` is an action's `value`, or "" to take it back. */
export interface NoteAnswer {
  note: DiffNote;
  action: string;
  text?: string;
}

interface Own {
  /** The `state` the click was made over. */
  base: string | undefined;
  state: string;
  answer?: string;
}

function isComment(note: DiffNote): boolean {
  return note.author !== undefined || note.replies !== undefined;
}

/** Whether `note` is drawn as a card rather than as a plain line of text. */
export function isCardNote(note: DiffNote, actions?: readonly NoteAction[]): boolean {
  return isComment(note) || (note.id !== undefined && ((note.actions ?? actions)?.length ?? 0) > 0);
}

/** One way to submit a comment being written: a button each, the first the primary one and ⌘↵'s. */
export interface ComposeAction {
  label: string;
  /** What is reported with the words. */
  value: string;
  /** The button's tooltip: what it does with the comment. */
  title?: string;
}

/** A comment being written on a line, before it is a note. */
export function NoteComposer({
  line,
  onSubmit,
  onCancel,
  placeholder = "What should change here?",
  submitLabel = "Comment",
  label = `Comment on line ${line}`,
  actions,
}: {
  /** Which line it is about, for the field's name. */
  line: number;
  /** The words, and the `value` of the action they were submitted with, when there are `actions`. */
  onSubmit: (text: string, action?: string) => void;
  onCancel: () => void;
  placeholder?: string;
  submitLabel?: string;
  /** The field's name; a comment on the line by default. */
  label?: string;
  /** Several ways to submit it, in place of the one `submitLabel` button. */
  actions?: readonly ComposeAction[];
}) {
  const [words, setWords] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  const submit = (action?: string) => {
    if (words.trim()) onSubmit(words.trim(), action ?? actions?.[0]?.value);
  };
  // The key the field submits with, on the button it presses.
  const keys = <kbd className="note-keys">{isMac() ? "⌘↵" : "Ctrl+↵"}</kbd>;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The diff around it steps on the arrow keys; typing here must not.
    event.stopPropagation();
    if (event.key === "Escape") onCancel();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="note-card composing" role="group" aria-label={`New ${label.charAt(0).toLowerCase()}${label.slice(1)}`}>
      <div className="note-card-ask">
        <textarea
          ref={field}
          aria-label={label}
          placeholder={placeholder}
          rows={2}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="gen-wi-actions">
          {actions && actions.length > 0 ? (
            actions.map((action, i) => (
              <button
                key={action.value}
                type="button"
                className={i === 0 ? "gen-button primary" : "gen-button"}
                title={action.title}
                aria-label={action.label}
                aria-keyshortcuts={i === 0 ? (isMac() ? "Meta+Enter" : "Control+Enter") : undefined}
                disabled={!words.trim()}
                onClick={() => submit(action.value)}
              >
                {action.label}
                {i === 0 ? keys : null}
              </button>
            ))
          ) : (
            <button
              type="button"
              className="gen-button primary"
              aria-label={submitLabel}
              aria-keyshortcuts={isMac() ? "Meta+Enter" : "Control+Enter"}
              disabled={!words.trim()}
              onClick={() => submit()}
            >
              {submitLabel}
              {keys}
            </button>
          )}
          <button type="button" className="gen-button borderless" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function NoteCard({
  note,
  actions: offered,
  onAnswer,
  file,
  collapsed = false,
  onToggle,
}: {
  note: DiffNote;
  actions?: readonly NoteAction[];
  onAnswer?: (answer: NoteAnswer) => void;
  /** It heads the file rather than sitting under a line. */
  file?: boolean;
  /** Drawn as its head alone, the first line of its text in it; `onToggle` opens it again. */
  collapsed?: boolean;
  /** Offers a caret in the head that collapses the card and opens it again. */
  onToggle?: () => void;
}) {
  const [own, setOwn] = useState<Own | null>(null);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<NoteAction | null>(null);
  const [words, setWords] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  // A note's own answers win over the ones the whole diff offers.
  const actions = note.actions ?? offered;

  // Once the owner says anything new, the click has had its answer.
  useEffect(() => {
    setOwn((current) => (current && current.base !== note.state ? null : current));
  }, [note.state]);
  useEffect(() => {
    if (asking) field.current?.focus();
  }, [asking]);

  const state = own ? own.state : note.state;
  const answer = own ? own.answer : note.answer;
  const answerable = note.id !== undefined && (actions?.length ?? 0) > 0 && onAnswer !== undefined;
  const decided = actions?.find((action) => action.value === state);

  const report = (action: string, text?: string) => {
    setOwn({ base: note.state, state: action, ...(text ? { answer: text } : {}) });
    setEditing(false);
    setAsking(null);
    setWords("");
    onAnswer?.({ note, action, ...(text ? { text } : {}) });
  };

  const pick = (action: NoteAction) => {
    if (action.input === undefined) {
      report(action.value);
      return;
    }
    setWords(state === action.value ? (answer ?? "") : "");
    setAsking(action);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The diff around it steps on the arrow keys; typing here must not.
    event.stopPropagation();
    if (event.key === "Escape") setAsking(null);
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && asking && words.trim()) {
      event.preventDefault();
      report(asking.value, words.trim());
    }
  };

  const url = note.url?.startsWith("https://") ? note.url : undefined;
  // Whose words they are: the person's own, or someone else's (an agent, a reviewer), told apart by colour.
  const whose = (author: string | undefined) => (author === undefined ? "" : author === "You" ? "mine" : "theirs");
  const classes = [
    "note-card",
    whose(note.author),
    file ? "file" : "",
    note.tone ?? "",
    decided && !editing ? "settled" : "",
    collapsed ? "collapsed" : "",
  ];
  const caret = onToggle ? (
    <button
      type="button"
      className="note-card-caret"
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand the comment" : "Collapse the comment"}
      title={collapsed ? "Expand" : "Collapse"}
      onClick={onToggle}
    >
      {collapsed ? <ChevronRight size={14} strokeWidth={2.25} /> : <ChevronDown size={14} strokeWidth={2.25} />}
    </button>
  ) : null;

  if (collapsed) {
    const replies = note.replies?.length ?? 0;
    return (
      <div className={classes.filter(Boolean).join(" ")} role="note" aria-label={note.author ? `Comment by ${note.author}` : "Note"} data-note={noteKey(note)}>
        <div className="note-card-head">
          {caret}
          {note.author ? <strong>{note.author}</strong> : null}
          <button type="button" className="note-card-summary" title="Expand" onClick={onToggle}>
            {note.text.split("\n")[0]}
          </button>
          {replies > 0 ? <span className="muted">{replies === 1 ? "1 reply" : `${replies} replies`}</span> : null}
          {note.tag ? <span className="pr-tag">{note.tag}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      role="note"
      aria-label={note.author ? `Comment by ${note.author}` : "Note"}
      data-note={noteKey(note)}
    >
      {note.author || note.tag || url || caret ? (
        <div className="note-card-head">
          {caret}
          {note.author ? <strong>{note.author}</strong> : null}
          {note.tag ? <span className="pr-tag">{note.tag}</span> : null}
          <span className="note-card-spacer" />
          {url ? (
            <button type="button" className="link" onClick={() => void openUrl(url)}>
              view on GitHub
            </button>
          ) : null}
        </div>
      ) : null}
      {isComment(note) ? <Markdown className="file-markdown note-card-md">{note.text}</Markdown> : <p>{note.text}</p>}
      {note.replies?.map((reply, i) => (
        <div key={i} className={`note-card-reply ${whose(reply.author)}`}>
          <strong>{reply.author}</strong>
          <Markdown className="file-markdown note-card-md">{reply.text}</Markdown>
        </div>
      ))}

      {answerable && asking ? (
        <div className="note-card-ask">
          <textarea
            ref={field}
            aria-label={asking.label}
            placeholder={asking.input}
            rows={2}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="gen-wi-actions">
            <button
              type="button"
              className="gen-button primary"
              disabled={!words.trim()}
              onClick={() => report(asking.value, words.trim())}
            >
              {asking.label}
            </button>
            <button type="button" className="gen-button borderless" onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : answerable && decided && !editing ? (
        <div className="note-card-decided">
          <div className="gen-wi-actions">
            <span className="note-card-state">{decided.done ?? decided.label}</span>
            <button type="button" className="gen-button borderless" onClick={() => setEditing(true)}>
              Change
            </button>
            <button type="button" className="gen-button borderless" onClick={() => report("")}>
              Undo
            </button>
          </div>
          {answer ? <p className="note-card-answer">{answer}</p> : null}
        </div>
      ) : answerable ? (
        <div className="gen-wi-actions">
          {actions!.map((action) => (
            <button
              key={action.value}
              type="button"
              className={action.primary ? "gen-button primary" : "gen-button"}
              onClick={() => pick(action)}
            >
              {action.label}
            </button>
          ))}
          {editing ? (
            <button type="button" className="gen-button borderless" onClick={() => setEditing(false)}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A note's name in the diff, for stepping from one to the next: its id, or where it sits when it has none. */
export const noteKey = (note: DiffNote): string => note.id ?? `${note.path}\0${note.side ?? "new"}\0${note.line ?? ""}\0${note.text}`;
