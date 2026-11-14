/**
 * `Commentable`: a part of a view the person can comment on, for the session's agent, in a thread it answers. One
 * component, or a group of them wrapped together; Shift-click several parts' comment buttons and one comment is about
 * all of them. Its threads show on every part they are about, and opening one lights up the others.
 *
 * The threads are Roer's (`lib/threads`), kept per repository and view. A view drawn where there is no repository or
 * no session to send to (another app's chat) draws the parts without the button.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { ThreadCards, ThreadComposer, useClaimSessions, useThreadPeople, useThreadSender, type ThreadSender } from "../Threads";
import { useViewThreads, type Thread } from "../lib/threads";

interface Part {
  id: string;
  label: string;
}

interface Scope {
  root: string;
  view: string;
  title?: string;
  threads: Thread[];
  sender: ThreadSender;
  /** The parts picked for the comment being written, in the order picked. */
  picked: Part[];
  pick: (part: Part, extend: boolean) => void;
  cancel: () => void;
  /** The part whose threads are open. */
  open: string | null;
  setOpen: (id: string | null) => void;
}

const CommentScopeContext = createContext<Scope | null>(null);

/** Where a view's parts are commented on: the repository and the view the threads are kept under. */
export function CommentScope({
  root,
  view,
  title,
  children,
}: {
  root: string | null;
  view: string;
  title?: string;
  children: ReactNode;
}) {
  const people = useThreadPeople();
  const threads = useViewThreads(root, view);
  const sender = useThreadSender(people);
  useClaimSessions(threads, people.sessions ?? []);
  const [picked, setPicked] = useState<Part[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const scope = useMemo<Scope | null>(
    () =>
      root
        ? {
            root,
            view,
            title,
            threads,
            sender,
            picked,
            pick: (part, extend) =>
              setPicked((current) =>
                !extend
                  ? [part]
                  : current.some((one) => one.id === part.id)
                    ? current.filter((one) => one.id !== part.id)
                    : [...current, part],
              ),
            cancel: () => setPicked([]),
            open,
            setOpen,
          }
        : null,
    [root, view, title, threads, sender, picked, open],
  );
  return <CommentScopeContext.Provider value={scope}>{children}</CommentScopeContext.Provider>;
}

/** "a", "a and b", "a, b and c". */
const names = (parts: readonly { label?: string; id: string }[]) => {
  const all = parts.map((one) => one.label || one.id);
  return all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
};

export function Commentable({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const scope = useContext(CommentScopeContext);
  if (!scope) return <>{children}</>;
  const part = { id, label: label || id };
  const mine = scope.threads.filter((thread) => thread.anchors.some((a) => a.kind === "part" && a.id === id));
  const live = mine.filter((thread) => thread.state === "open");
  const picked = scope.picked.some((one) => one.id === id);
  // The composer sits under the last part picked; the threads under the part whose threads are open.
  const writing = scope.picked.at(-1)?.id === id;
  const showing = scope.open === id;
  // Lit when a thread open elsewhere is about this part too.
  const linked =
    !showing &&
    scope.open !== null &&
    scope.threads.some(
      (thread) =>
        thread.anchors.some((a) => a.kind === "part" && a.id === scope.open) &&
        thread.anchors.some((a) => a.kind === "part" && a.id === id),
    );
  const classes = ["gen-commentable", picked ? "picked" : "", linked ? "linked" : "", showing ? "showing" : ""];

  return (
    <div className={classes.filter(Boolean).join(" ")} data-part={id}>
      {children}
      <div className="gen-comment-tools">
        {mine.length > 0 ? (
          <button
            type="button"
            className="gen-comment-count"
            aria-pressed={showing}
            aria-label={`${live.length} open of ${mine.length} ${mine.length === 1 ? "thread" : "threads"} on ${part.label}`}
            onClick={() => scope.setOpen(showing ? null : id)}
          >
            {live.length > 0 ? live.length : "✓"}
          </button>
        ) : null}
        <button
          type="button"
          className="gen-comment-add"
          aria-label={`Comment on ${part.label}`}
          title="Comment for the session's agent; Shift-click other parts to comment on them together"
          onClick={(event) => scope.pick(part, event.shiftKey)}
        >
          +
        </button>
      </div>
      {showing ? (
        <div className="gen-comment-threads">
          <ThreadCards threads={mine} sender={scope.sender} name={(thread) => names(partsOf(thread))} />
        </div>
      ) : null}
      {writing ? (
        <div className="gen-comment-threads">
          <ThreadComposer
            root={scope.root}
            sender={scope.sender}
            name={names(scope.picked)}
            onSubmit={(text) => {
              const started = scope.sender.start({
                root: scope.root,
                view: scope.view,
                ...(scope.title ? { viewTitle: scope.title } : {}),
                anchors: scope.picked.map((one) => ({ kind: "part", id: one.id, label: one.label })),
                text,
              });
              scope.cancel();
              scope.setOpen(started.anchors.at(-1)?.kind === "part" ? id : null);
            }}
            onCancel={scope.cancel}
          />
        </div>
      ) : null}
    </div>
  );
}

const partsOf = (thread: Thread) =>
  thread.anchors.flatMap((a) => (a.kind === "part" ? [{ id: a.id, ...(a.label ? { label: a.label } : {}) }] : []));
