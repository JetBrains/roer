/**
 * A work item opened up: what it is for, what still needs the user, what was
 * asked, where it came from, and what changed. The sections stand alone in
 * the catalog too, for an agent that wants only one of them.
 *
 * What the user does here — ticks a requirement, settles a finding, answers
 * a decision — goes to the agent as an action and is shown at once, but it
 * is not written into the data model. The agent's copy stays the truth: the
 * panel holds its own answer only while the agent's value is still the one
 * it replaced, so the agent resending the old item does not undo a click,
 * and the agent sending anything else wins.
 */
import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { DiffPane, type DiffPaneProps } from "../DiffPane";
import { Markdown } from "../Markdown";
import type { NoteAction, NoteAnswer } from "../DiffNote";
import { splitPatch, type DiffNote } from "../lib/diff";
import type { FileChange } from "../lib/git";
import { openUrl } from "../lib/github";
import type {
  ChangeRef,
  Comment,
  Decision,
  Finding,
  FindingState,
  Requirement,
  SourceRef,
} from "./workItem";

/** Reports one thing the user did, as a button's event would. */
export type Report = (name: string, context: Record<string, unknown>) => void;

/** `items` with the user's own values over `key`, as the file comment says. */
export function useLocal<T extends { id: string }, K extends keyof T>(items: T[], key: K) {
  const [pending, setPending] = useState<Record<string, { base: T[K]; value: T[K] }>>({});
  // Once the agent says anything new about an item, the user's value has had
  // its answer; forgetting it keeps a later resend of the old value from
  // bringing it back.
  useEffect(() => {
    setPending((current) => {
      const kept = Object.entries(current).filter(([id, own]) =>
        items.some((item) => item.id === id && Object.is(item[key], own.base)),
      );
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [items, key]);
  const shown = items.map((item) => {
    const own = pending[item.id];
    return own && Object.is(own.base, item[key]) ? { ...item, [key]: own.value } : item;
  });
  const set = (id: string, value: T[K]) => {
    const item = items.find((i) => i.id === id);
    if (item) setPending((current) => ({ ...current, [id]: { base: item[key], value } }));
  };
  return [shown, set] as const;
}

/**
 * The Changes tab's own `DiffPane` — tree, hunk stepping, split and unified
 * layouts, highlighting — over a patch handed in as text. It reads nothing
 * from disk: `loadDiff` only ever answers with a slice of `patch`, so a
 * surface can show any range without running git itself.
 */
export function PatchPane({
  patch,
  title,
  layout,
  emptyText,
  notes,
  noteActions,
  onNoteAnswer,
  reveal,
  onAddNote,
  "aria-label": label,
  ...common
}: {
  patch: string;
  title: string;
  layout?: "unified" | "split";
  emptyText: string;
  notes?: DiffNote[];
  /** How a note with an `id` can be answered: accept, decline, say what to do. */
  noteActions?: readonly NoteAction[];
  onNoteAnswer?: (answer: NoteAnswer) => void;
  reveal?: DiffPaneProps["reveal"];
  /** Lets the viewer comment on any line; see `DiffPane`. */
  onAddNote?: DiffPaneProps["onAddNote"];
  "aria-label"?: string;
  style?: CSSProperties;
}) {
  const files = useMemo(() => splitPatch(patch), [patch]);
  const changes = useMemo(
    () =>
      files.map(
        (file): FileChange => ({
          path: file.path,
          // A patch says nothing about the index; calling every change
          // unstaged keeps the tree from marking any of them staged.
          staged: ".",
          unstaged: file.status,
          added: file.added,
          deleted: file.deleted,
          renamedFrom: file.renamedFrom ?? null,
          binary: file.binary,
          counted: !file.binary,
        }),
      ),
    [files],
  );
  const loadDiff = useCallback(
    (path: string) => Promise.resolve(files.find((file) => file.path === path)?.text ?? ""),
    [files],
  );
  return (
    <div {...common} className="gen-diff">
      <DiffPane
        files={changes}
        error={null}
        // Never takes focus by itself: the panel sits beside a terminal the
        // user is typing into. Clicking into it still gives it the arrow keys.
        active={false}
        loadDiff={loadDiff}
        resetKey={patch}
        title={title}
        emptyMessage={emptyText}
        defaultLayout={layout}
        notes={notes}
        noteActions={noteActions}
        onNoteAnswer={onNoteAnswer}
        reveal={reveal}
        onAddNote={onAddNote}
        aria-label={label ?? "Diff"}
      />
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="gen-wi-section" aria-label={title}>
      <h3 className="gen-wi-heading">
        {title}
        {aside ? <span className="gen-wi-aside">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

export function RequirementsSection({
  items,
  onToggle,
}: {
  items: Requirement[];
  onToggle: (id: string, met: boolean) => void;
}) {
  const met = items.filter((r) => r.met).length;
  return (
    <Section title="Requirements" aside={`${met} of ${items.length}`}>
      <ul className="gen-wi-list">
        {items.map((r) => (
          <li key={r.id}>
            <label className={r.met ? "gen-checkbox gen-wi-met" : "gen-checkbox"}>
              <input type="checkbox" checked={r.met} onChange={(e) => onToggle(r.id, e.target.checked)} />
              <span>{r.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SourcesSection({
  items,
  onOpenFile,
}: {
  items: SourceRef[];
  onOpenFile?: (path: string) => void;
}) {
  return (
    <Section title="Sources">
      <ul className="gen-wi-sources">
        {items.map((source, i) => {
          // Only https leaves the app, as for a work item's own link.
          const url = source.url?.startsWith("https://") ? source.url : undefined;
          const open = source.path && onOpenFile
            ? () => onOpenFile(source.path!)
            : url
              ? () => void openUrl(url)
              : undefined;
          const body = (
            <>
              <span className="gen-wi-kind">{source.kind}</span>
              {source.label}
            </>
          );
          return (
            <li key={i}>
              {open ? (
                <button type="button" className="gen-wi-source" title={source.path ?? url} onClick={open}>
                  {body}
                </button>
              ) : (
                <span className="gen-wi-source">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Read-only: nothing here writes back, so there is no `onX` to thread
 * through the way `Requirements`/`Findings`/`Decisions` have one. A comment is
 * Markdown, as a YouTrack ticket's or a GitHub issue's is. */
export function CommentsSection({ items }: { items: Comment[] }) {
  return (
    <Section title="Comments">
      <ul className="gen-wi-comments">
        {items.map((c) => (
          <li key={c.id}>
            <div className="gen-wi-comment-head">
              <span className="gen-wi-comment-author">{c.author}</span>
              {c.at ? <span className="gen-wi-comment-at">{c.at}</span> : null}
            </div>
            <Markdown className="gen-wi-comment-text md-inline">{c.text}</Markdown>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Open ones first: they are what the section is for. */
const openFirst = <T,>(items: T[], isOpen: (item: T) => boolean) => [
  ...items.filter(isOpen),
  ...items.filter((item) => !isOpen(item)),
];

export function FindingsList({
  items,
  onSettle,
  onReveal,
}: {
  items: Finding[];
  onSettle: (id: string, state: FindingState) => void;
  /** Shows a finding's line; without it, the line is only named. */
  onReveal?: (finding: Finding) => void;
}) {
  return (
    <ul className="gen-wi-list">
      {openFirst(items, (f) => f.state === "open").map((f) => {
        const where = f.at ? `${f.at.path}:${f.at.line}` : null;
        return (
          <li key={f.id} className={f.state === "open" ? "gen-wi-finding" : "gen-wi-finding settled"}>
            <span className={`gen-wi-severity ${f.severity}`}>{f.severity}</span>
            <div className="gen-wi-finding-body">
              <span>{f.text}</span>
              {where ? (
                onReveal ? (
                  <button type="button" className="link gen-wi-where" onClick={() => onReveal(f)}>
                    {where}
                  </button>
                ) : (
                  <span className="gen-wi-where">{where}</span>
                )
              ) : null}
            </div>
            <div className="gen-wi-actions">
              {f.state === "open" ? (
                <>
                  <button type="button" className="gen-button" onClick={() => onSettle(f.id, "resolved")}>
                    Resolve
                  </button>
                  <button type="button" className="gen-button borderless" onClick={() => onSettle(f.id, "dismissed")}>
                    Dismiss
                  </button>
                </>
              ) : (
                <>
                  <span className="gen-wi-state">{f.state}</span>
                  <button type="button" className="gen-button borderless" onClick={() => onSettle(f.id, "open")}>
                    Reopen
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const OTHER = "\u0000other";

function DecisionRow({ decision, onAnswer }: { decision: Decision; onAnswer: (id: string, answer: string) => void }) {
  const name = useId();
  const known = decision.options.some((o) => o.value === decision.answer);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(decision.answer === undefined ? "" : known ? decision.answer : OTHER);
  const [other, setOther] = useState(decision.answer !== undefined && !known ? decision.answer : "");
  const answer = choice === OTHER ? other.trim() : choice;

  if (decision.answer !== undefined && !editing) {
    const label = decision.options.find((o) => o.value === decision.answer)?.label ?? decision.answer;
    return (
      <li className="gen-wi-decision settled">
        <span className="gen-wi-question">{decision.question}</span>
        <div className="gen-wi-actions">
          <span className="gen-wi-state">Answered: {label}</span>
          <button type="button" className="gen-button borderless" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="gen-wi-decision">
      <fieldset>
        <legend className="gen-wi-question">{decision.question}</legend>
        {decision.options.map((o) => (
          <label key={o.value} className="gen-choice-option">
            <input type="radio" name={name} checked={choice === o.value} onChange={() => setChoice(o.value)} />
            {o.label}
          </label>
        ))}
        <label className="gen-choice-option">
          <input type="radio" name={name} checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
          Other
        </label>
        {choice === OTHER ? (
          <input
            className="gen-wi-other"
            aria-label="Your answer"
            placeholder="Your answer"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
        ) : null}
      </fieldset>
      <div className="gen-wi-actions">
        <button
          type="button"
          className="gen-button primary"
          disabled={!answer}
          onClick={() => {
            onAnswer(decision.id, answer);
            setEditing(false);
          }}
        >
          Answer
        </button>
      </div>
    </li>
  );
}

export function DecisionsList({
  items,
  onAnswer,
}: {
  items: Decision[];
  onAnswer: (id: string, answer: string) => void;
}) {
  return (
    <ul className="gen-wi-list">
      {openFirst(items, (d) => d.answer === undefined).map((d) => (
        <DecisionRow key={d.id} decision={d} onAnswer={onAnswer} />
      ))}
    </ul>
  );
}

function ChangeBlock({
  change,
  findings,
  open,
  onToggle,
  reveal,
}: {
  change: ChangeRef;
  findings: Finding[];
  open: boolean;
  onToggle: () => void;
  reveal?: DiffPaneProps["reveal"];
}) {
  const files = useMemo(() => splitPatch(change.patch), [change.patch]);
  const added = files.reduce((sum, f) => sum + f.added, 0);
  const deleted = files.reduce((sum, f) => sum + f.deleted, 0);
  // Open findings on this change are drawn where they point, beside the
  // change's own notes; a settled one has said what it had to.
  const notes = useMemo(
    () => [
      ...(change.notes ?? []),
      ...findings
        .filter((f) => f.state === "open" && f.at?.changeId === change.id)
        .map((f): DiffNote => ({ path: f.at!.path, line: f.at!.line, side: f.at!.side, text: f.text, tone: f.severity })),
    ],
    [change, findings],
  );
  return (
    <div className="gen-wi-change">
      <button type="button" className="gen-expandable-header" aria-expanded={open} onClick={onToggle}>
        <span className={open ? "gen-expandable-chevron open" : "gen-expandable-chevron"}>▶</span>
        {change.title}
        <span className="counts">
          <span className="plus">+{added}</span> <span className="minus">−{deleted}</span>
        </span>
      </button>
      {open ? (
        <PatchPane patch={change.patch} title={change.title} emptyText="No changes." notes={notes} reveal={reveal} />
      ) : null}
    </div>
  );
}

export interface WorkItemDetailProps {
  /** The item's `key`, sent with every action so the agent knows which. */
  itemKey: string;
  goal: string;
  requirements: Requirement[];
  sources: SourceRef[];
  comments: Comment[];
  changes: ChangeRef[];
  findings: Finding[];
  decisions: Decision[];
  report: Report;
  onOpenFile?: (path: string) => void;
}

/** Everything under a work item's header, in the order it asks for
 * attention: the goal, what needs the user, then the rest. */
export function WorkItemDetail({
  itemKey,
  goal,
  requirements: sentRequirements,
  sources,
  comments,
  changes,
  findings: sentFindings,
  decisions: sentDecisions,
  report,
  onOpenFile,
}: WorkItemDetailProps) {
  const [requirements, setMet] = useLocal(sentRequirements, "met");
  const [findings, setState] = useLocal(sentFindings, "state");
  const [decisions, setAnswer] = useLocal(sentDecisions, "answer");
  // One change open by default when there is only one to open.
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(changes.length === 1 ? [changes[0].id] : []),
  );
  const [reveal, setReveal] = useState<{ changeId: string; target: NonNullable<DiffPaneProps["reveal"]> } | null>(
    null,
  );

  const waiting =
    decisions.filter((d) => d.answer === undefined).length + findings.filter((f) => f.state === "open").length;
  const canReveal = (f: Finding) => changes.some((c) => c.id === f.at?.changeId);

  return (
    <div className="gen-wi-detail">
      {goal ? <Markdown className="gen-wi-goal md-inline">{goal}</Markdown> : null}

      {decisions.length + findings.length > 0 ? (
        <Section title="Needs you" aside={waiting > 0 ? String(waiting) : "nothing open"}>
          <DecisionsList
            items={decisions}
            onAnswer={(id, answer) => {
              setAnswer(id, answer);
              report("answerDecision", { workItem: itemKey, id, answer });
            }}
          />
          <FindingsList
            items={findings}
            onSettle={(id, state) => {
              setState(id, state);
              report("settleFinding", { workItem: itemKey, id, state });
            }}
            onReveal={(f) => {
              if (!f.at || !canReveal(f)) return;
              const { changeId, path, line, side } = f.at;
              setOpened((current) => new Set(current).add(changeId));
              setReveal((current) => ({ changeId, target: { path, line, side, seq: (current?.target.seq ?? 0) + 1 } }));
            }}
          />
        </Section>
      ) : null}

      {requirements.length > 0 ? (
        <RequirementsSection
          items={requirements}
          onToggle={(id, met) => {
            setMet(id, met);
            report("toggleRequirement", { workItem: itemKey, id, met });
          }}
        />
      ) : null}

      {sources.length > 0 ? <SourcesSection items={sources} onOpenFile={onOpenFile} /> : null}

      {comments.length > 0 ? <CommentsSection items={comments} /> : null}

      {changes.length > 0 ? (
        <Section title="Changes">
          {changes.map((change) => (
            <ChangeBlock
              key={change.id}
              change={change}
              findings={findings}
              open={opened.has(change.id)}
              onToggle={() =>
                setOpened((current) => {
                  const next = new Set(current);
                  if (!next.delete(change.id)) next.add(change.id);
                  return next;
                })
              }
              reveal={reveal?.changeId === change.id ? reveal.target : undefined}
            />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

/** `Requirements`, on its own. */
export function RequirementsNode({ items, report }: { items: Requirement[]; report: Report }) {
  const [shown, setMet] = useLocal(items, "met");
  return (
    <RequirementsSection
      items={shown}
      onToggle={(id, met) => {
        setMet(id, met);
        report("toggleRequirement", { id, met });
      }}
    />
  );
}

/** `Findings`, on its own: with no diff beside it, a line is only named. */
export function FindingsNode({ items, report }: { items: Finding[]; report: Report }) {
  const [shown, setState] = useLocal(items, "state");
  return (
    <Section title="Findings">
      <FindingsList
        items={shown}
        onSettle={(id, state) => {
          setState(id, state);
          report("settleFinding", { id, state });
        }}
      />
    </Section>
  );
}

/** `Decisions`, on its own. */
export function DecisionsNode({ items, report }: { items: Decision[]; report: Report }) {
  const [shown, setAnswer] = useLocal(items, "answer");
  return (
    <Section title="Decisions">
      <DecisionsList
        items={shown}
        onAnswer={(id, answer) => {
          setAnswer(id, answer);
          report("answerDecision", { id, answer });
        }}
      />
    </Section>
  );
}

/** `Comments`, on its own. */
export function CommentsNode({ items }: { items: Comment[] }) {
  return <CommentsSection items={items} />;
}
