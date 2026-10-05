import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { canStart, type AgentList } from "./lib/agents";
import type { Place } from "./lib/checkouts";
import { gitBranches } from "./lib/git";
import type { Project } from "./lib/projects";
import { SHELL } from "./lib/useSessionBrowser";
import type { CreatedWorktree } from "./lib/worktrees";
import { matchesQuery } from "./GoToFile";

/** Which question the picker opens on: where the session goes, or, with
 * that settled, what it starts. */
export type PickerStart = { step: "where" } | { step: "with"; cwd: string };

export interface NewSessionPickerProps {
  /** Every checkout to offer, the current one first. */
  places: Place[];
  /** The agents for `agentsCwd`, as the app already has them. */
  agents: AgentList | null;
  agentsCwd?: string;
  /** The agents for another folder: a Project's own agents and default go
   * with its checkout, so Start with asks for the one it starts in. */
  loadAgents?: (cwd: string) => Promise<AgentList>;
  start: PickerStart;
  onCreateWorktree: (projectPath: string, name: string, base: string) => Promise<CreatedWorktree>;
  /** Starts the session in `cwd`, with `agent` (or the default). */
  onStart: (cwd: string, agent?: string) => void;
  /** "Attach a folder as a project…"; not offered without it. */
  onAttachNewProject?: () => void;
  onClose: () => void;
}

type Step = "where" | "base" | "with" | "made";

/** Where it was settled to go: a checkout, or a worktree still to make. */
type Where = { kind: "place"; place: Place } | { kind: "new"; project: Project; name: string };

interface Row {
  key: string;
  name: string;
  detail?: string;
  badge?: string;
  /** What the query is matched against; a row without any is always shown. */
  fields?: Array<string | null | undefined>;
  /** `undefined` for a row that is only read, not picked. */
  pick?: () => void;
  /** A row only read that is no warning, such as one saying it waits. */
  quiet?: boolean;
}

const TITLES: Record<Step, string> = {
  where: "Where",
  base: "Branch from",
  with: "Start with",
  made: "Made, but",
};

/**
 * A new session somewhere else, or with something else, asked the way Go to
 * File asks: a box to type in over a list, a question at a time, the likely
 * answer already highlighted so Enter alone takes it.
 *
 * Where — any checkout of the Projects in view, or a new worktree named by
 * whatever was typed; Branch from — only for a new worktree; Start with —
 * which agent. Backspace in an empty box goes back a question, Escape
 * leaves.
 */
export function NewSessionPicker({
  places,
  agents: known,
  agentsCwd,
  loadAgents,
  start,
  onCreateWorktree,
  onStart,
  onAttachNewProject,
  onClose,
}: NewSessionPickerProps) {
  const opening = start.step === "with" ? places.find((place) => place.cwd === start.cwd) : undefined;
  const [step, setStep] = useState<Step>(start.step);
  const [where, setWhere] = useState<Where | null>(
    start.step === "with"
      ? {
          kind: "place",
          place: opening ?? {
            key: start.cwd,
            cwd: start.cwd,
            project: null,
            label: start.cwd,
            linked: false,
            here: false,
          },
        }
      : null,
  );
  const [base, setBase] = useState("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(0);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ created: CreatedWorktree; agent?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Again once whatever opened it is done: a menu that closes as it opens
  // the picker puts the focus back where it was a moment later.
  useEffect(() => {
    inputRef.current?.focus();
    const later = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(later);
  }, [step]);

  const newProject = where?.kind === "new" ? where.project.path : undefined;
  useEffect(() => {
    if (!newProject) return;
    let live = true;
    void gitBranches(newProject)
      .then((list) => live && setBranches(list))
      .catch(() => live && setBranches([]));
    return () => {
      live = false;
    };
  }, [newProject]);

  const goTo = (next: Step) => {
    setStep(next);
    setQuery("");
    setChosen(0);
    setError(null);
  };

  const finish = (agent?: string) => {
    if (!where) return;
    if (where.kind === "place") {
      onStart(where.place.cwd, agent);
      return;
    }
    setBusy(true);
    setError(null);
    onCreateWorktree(where.project.path, where.name, base)
      .then((created) => {
        if (created.warnings.length === 0) {
          onStart(created.worktree.path, agent);
          return;
        }
        setBusy(false);
        setMade({ created, agent });
        goTo("made");
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(String(cause));
      });
  };

  // Where the agents are asked about: the checkout settled on, or, for a
  // worktree not made yet, its Project's main checkout, which has the same
  // project agents.
  const target = where ? (where.kind === "place" ? where.place.cwd : where.project.path) : undefined;
  const [scoped, setScoped] = useState<{ cwd: string; list: AgentList | null } | null>(null);
  useEffect(() => {
    if (!target || target === agentsCwd || !loadAgents) return;
    let live = true;
    void loadAgents(target)
      .then((list) => live && setScoped({ cwd: target, list }))
      // Unreadable there: the ones the app has, rather than none.
      .catch(() => live && setScoped({ cwd: target, list: null }));
    return () => {
      live = false;
    };
  }, [target, agentsCwd, loadAgents]);
  const agents: AgentList | null | undefined =
    !target || target === agentsCwd || !loadAgents
      ? known
      : scoped?.cwd === target
        ? (scoped.list ?? known)
        : undefined;

  const projects = useMemo(() => {
    const seen = new Map<string, Project>();
    for (const place of places) if (place.project) seen.set(place.project.id, place.project);
    return [...seen.values()];
  }, [places]);

  const startable = agents?.agents.filter((agent) => canStart(agents, agent)) ?? [];
  const byDefault = [
    ...startable.filter((agent) => agent.id === agents?.default),
    ...startable.filter((agent) => agent.id !== agents?.default),
  ];

  const rows: Row[] = (() => {
    const typed = query.trim();
    if (step === "where") {
      const found: Row[] = places.map((place) => ({
        key: `place:${place.key}`,
        name: place.label,
        detail: place.project ? undefined : "outside every project",
        badge: place.here ? "here" : place.linked ? "worktree" : undefined,
        fields: [place.label, place.cwd],
        pick: () => {
          setWhere({ kind: "place", place });
          goTo("with");
        },
      }));
      const fresh: Row[] = typed
        ? projects.map((project) => ({
            key: `new:${project.id}`,
            name: `New worktree “${typed}” in ${project.name}`,
            detail: "a checkout of its own, on a new branch",
            pick: () => {
              setWhere({ kind: "new", project, name: typed });
              setBase("");
              goTo("base");
            },
          }))
        : [];
      const attach: Row[] = onAttachNewProject
        ? [
            {
              key: "attach",
              name: "Attach a folder as a project…",
              fields: ["attach a folder as a new project"],
              pick: onAttachNewProject,
            },
          ]
        : [];
      return [...found, ...fresh, ...attach].filter((row) => !row.fields || matchesQuery(row.fields, typed));
    }
    if (step === "base") {
      const all: Row[] = [
        {
          key: "base:",
          name: "The default branch",
          detail: "fetched first",
          fields: ["default branch main master origin"],
          pick: () => {
            setBase("");
            goTo("with");
          },
        },
        ...branches.map((branch) => ({
          key: `base:${branch}`,
          name: branch,
          fields: [branch],
          pick: () => {
            setBase(branch);
            goTo("with");
          },
        })),
      ];
      const matching = all.filter((row) => !row.fields || matchesQuery(row.fields, typed));
      // Anything else typed — a tag, a commit, a remote branch — is taken
      // as it is, and git says if it names nothing.
      const exact = branches.includes(typed) || !typed;
      return exact
        ? matching
        : [
            ...matching,
            {
              key: `base-typed:${typed}`,
              name: typed,
              detail: "as typed",
              pick: () => {
                setBase(typed);
                goTo("with");
              },
            },
          ];
    }
    if (step === "with") {
      // Not yet known for this checkout: nothing to pick, so Enter cannot
      // start an agent that is not there.
      if (agents === undefined) return [{ key: "agents:loading", name: "Looking for agents…", quiet: true }];
      return [
        ...byDefault.map((agent) => ({
          key: `agent:${agent.source}-${agent.id}`,
          name: agent.name,
          badge: agent.id === agents?.default ? "default" : undefined,
          fields: [agent.name, agent.cli, agent.id],
          pick: () => finish(agent.id),
        })),
        { key: "agent:shell", name: "Shell", detail: "no agent", fields: ["shell terminal"], pick: () => finish(SHELL) },
      ].filter((row) => matchesQuery(row.fields, typed));
    }
    // made: start anyway first, then what went wrong, to read.
    const done = made;
    if (!done) return [];
    return [
      {
        key: "made:start",
        name: "Start anyway",
        detail: "copy what is missing by hand",
        pick: () => onStart(done.created.worktree.path, done.agent),
      },
      ...done.created.warnings.map((warning) => ({ key: `made:${warning}`, name: warning })),
    ];
  })();

  const at = Math.min(chosen, Math.max(rows.length - 1, 0));

  const back = () => {
    if (step === "with" && where?.kind === "new") goTo("base");
    else if ((step === "with" || step === "base") && start.step === "where") goTo("where");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace" && query === "" && !busy) {
      event.preventDefault();
      back();
      return;
    }
    const pickable = rows.map((row, index) => (row.pick ? index : -1)).filter((index) => index >= 0);
    const move = (delta: number) => {
      if (pickable.length === 0) return;
      const from = pickable.indexOf(at);
      setChosen(pickable[(from + delta + pickable.length) % pickable.length]);
    };
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Enter: () => !busy && rows[at]?.pick?.(),
      Escape: () => !busy && onClose(),
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  };

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [at, step]);

  // As Go to File does: a resting pointer under rows that scroll is no move.
  const wasAtRef = useRef<{ x: number; y: number } | null>(null);
  const hover = (event: MouseEvent, index: number) => {
    const last = wasAtRef.current;
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    wasAtRef.current = { x: event.clientX, y: event.clientY };
    if (rows[index]?.pick) setChosen(index);
  };

  const crumbs = [
    where ? (where.kind === "place" ? where.place.label : `New worktree “${where.name}” in ${where.project.name}`) : null,
    where?.kind === "new" && step !== "base" ? `from ${base || "the default branch"}` : null,
  ].filter(Boolean);
  const status = busy
    ? "Making the worktree…"
    : (error ?? [...crumbs, TITLES[step]].join("  ›  "));

  return (
    <div className="popup-scrim" onMouseDown={() => !busy && onClose()}>
      <div
        className="popup picker"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="popup-input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="new-session-list"
          aria-activedescendant={rows[at] ? `new-session-${at}` : undefined}
          aria-label={TITLES[step]}
          placeholder={
            step === "where"
              ? "A checkout, or a name for a new worktree"
              : step === "base"
                ? "A branch, tag or commit"
                : step === "with"
                  ? "An agent"
                  : ""
          }
          spellCheck={false}
          autoComplete="off"
          readOnly={busy || step === "made"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setChosen(0);
          }}
          onKeyDown={onKeyDown}
        />
        <p className={error ? "popup-status error" : "popup-status"}>{status}</p>
        <div id="new-session-list" className="popup-list" role="listbox" aria-label={TITLES[step]} ref={listRef}>
          {rows.length === 0 ? <div className="hit muted">Nothing matches</div> : null}
          {rows.map((row, index) => (
            <div
              key={row.key}
              id={`new-session-${index}`}
              role="option"
              aria-selected={index === at}
              aria-disabled={row.pick ? undefined : true}
              className={index === at && row.pick ? "hit on" : row.pick || row.quiet ? "hit" : "hit note"}
              onMouseDown={(event) => {
                event.preventDefault();
                if (!busy) row.pick?.();
              }}
              onMouseMove={(event) => hover(event, index)}
            >
              <span className="hit-name">{row.name}</span>
              {row.detail ? <span className="hit-dir">{row.detail}</span> : null}
              {row.badge ? <span className="hit-badge">{row.badge}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
