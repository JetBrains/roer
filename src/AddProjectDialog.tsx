import { useEffect, useMemo, useRef, useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { pickFolder } from "./lib/folderPicker";
import type { Project } from "./lib/projects";
import type { AddProjectMode, AddProjectRequest, AddProjectStart } from "./lib/useSessionBrowser";
import type { Workspace } from "./lib/workspaces";
import { shorten } from "./SessionBrowser";

/** The folder a clone of `url` gets by default, as git names it. */
export function repoName(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

const MODES: [AddProjectMode, string][] = [
  ["clone", "Clone"],
  ["folder", "Folder on disk"],
  ["known", "Known project"],
];

/**
 * Every way a project comes to a Workspace, in one place: cloned, picked
 * from disk, or one Roer already knows. Which Workspace is asked
 * here too, rather than taken from wherever the dialog was opened, since
 * there can be many.
 */
export function AddProjectDialog({
  start,
  workspaces,
  projects,
  home,
  parentFor,
  onAdd,
  onClose,
}: {
  start: AddProjectStart;
  workspaces: Workspace[];
  projects: Project[];
  home?: string;
  /** Where a clone goes by default, for a Workspace. */
  parentFor: (workspaceId: string | undefined) => string | undefined;
  onAdd: (request: AddProjectRequest) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<AddProjectMode>(start.mode ?? "clone");
  const [workspaceId, setWorkspaceId] = useState(start.workspaceId ?? workspaces[0]?.id ?? "");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  // Follows the URL until it is typed in itself.
  const [nameEdited, setNameEdited] = useState(false);
  const [parent, setParent] = useState(() => shorten(parentFor(workspaceId) ?? "", home));
  const [parentEdited, setParentEdited] = useState(false);
  const [session, setSession] = useState(true);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    const back = document.activeElement;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const shownName = nameEdited ? name : repoName(url);
  const full = (path: string) => (home && (path === "~" || path.startsWith("~/")) ? home + path.slice(1) : path);
  const dest = `${full(parent.trim()).replace(/[\\/]+$/, "")}/${shownName.trim()}`;

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects
      .filter((project) => !workspace?.projects.includes(project.id))
      .filter((project) => !needle || `${project.name} ${project.path}`.toLowerCase().includes(needle))
      // Newest first: the registry keeps them in the order they came.
      .reverse();
  }, [projects, workspace, query]);

  const problem = (() => {
    if (!workspace) return "Pick a workspace.";
    if (mode === "clone" && !url.trim()) return "";
    if (mode === "clone") {
      if (!shownName.trim()) return "Name the folder it goes in.";
      if (/[/\\]/.test(shownName)) return "The name is one folder, without slashes.";
      if (!parent.trim()) return "Say where it goes.";
      if (!/^([/~]|[A-Za-z]:)/.test(parent.trim())) return "Where it goes is a full path.";
      // Each is typed into a shell in single quotes, whichever shell it is.
      if (`${url}${dest}`.includes("'")) return "A quote in the URL or path is not supported.";
    }
    if (mode === "known" && !candidates.some((project) => project.id === projectId)) return "";
    return null;
  })();

  const submit = () => {
    if (problem !== null || !workspace) return;
    const base = { workspaceId: workspace.id, session };
    if (mode === "clone") onAdd({ ...base, mode, url: url.trim(), dest });
    else if (mode === "folder") onAdd({ ...base, mode });
    else if (projectId) onAdd({ ...base, mode, projectId });
  };

  const chooseParent = async () => {
    const picked = await pickFolder();
    if (typeof picked !== "string") return;
    setParent(shorten(picked, home));
    setParentEdited(true);
  };

  const changeWorkspace = (id: string) => {
    setWorkspaceId(id);
    if (!parentEdited) setParent(shorten(parentFor(id) ?? "", home));
  };

  const action = { clone: "Clone", folder: "Choose folder…", known: "Add" }[mode];

  return (
    <div className="popup-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className="popup setup add-project"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <h2 id="add-project-title">Add a project</h2>

        <div className="segmented wrap" role="radiogroup" aria-label="How">
          {MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={mode === value ? "on" : undefined}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "clone" ? (
          <Field label="URL">
            <input
              className="mono"
              value={url}
              placeholder="git@github.com:owner/repo.git"
              autoFocus
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
        ) : null}

        {mode === "clone" ? (
          <>
            <Field label="Name">
              <input
                className="mono"
                value={shownName}
                placeholder="From the URL"
                spellCheck={false}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
              />
            </Field>
            <Field label="In" hint={shownName.trim() && parent.trim() ? shorten(dest, home) : undefined}>
              <span className="add-project-parent">
                <input
                  className="mono"
                  value={parent}
                  spellCheck={false}
                  onChange={(event) => {
                    setParent(event.target.value);
                    setParentEdited(true);
                  }}
                />
                <button type="button" onClick={() => void chooseParent()}>
                  Choose…
                </button>
              </span>
            </Field>
          </>
        ) : null}

        {mode === "folder" ? (
          <p className="muted">
            A git repository already on disk. A folder of them asks which to take, as projects of the workspace below or of a
            new one.
          </p>
        ) : null}

        {mode === "known" ? (
          <div className="add-project-known">
            <input
              value={query}
              placeholder="Search projects"
              autoFocus
              aria-label="Search projects"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const at = candidates.findIndex((project) => project.id === projectId);
                  const next = event.key === "ArrowDown" ? Math.min(at + 1, candidates.length - 1) : Math.max(at - 1, 0);
                  setProjectId(candidates[next]?.id ?? null);
                }
              }}
            />
            {candidates.length === 0 ? (
              <p className="muted">{query ? "None match." : `Every project Roer knows is in ${workspace?.name ?? "it"} already.`}</p>
            ) : (
              <ul role="listbox" aria-label="Projects">
                {candidates.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={project.id === projectId}
                      className={project.id === projectId ? "row wrap active" : "row wrap"}
                      title={project.path}
                      onClick={() => setProjectId(project.id)}
                      onDoubleClick={() => {
                        setProjectId(project.id);
                        if (workspace) onAdd({ workspaceId: workspace.id, session, mode: "known", projectId: project.id });
                      }}
                    >
                      <strong>{project.name}</strong>
                      <span className="muted">{shorten(project.path, home)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <Field label="Workspace" hint={mode === "clone" ? "The project is attached to it." : undefined}>
          <Select value={workspaceId} onValueChange={changeWorkspace}>
            <SelectTrigger size="sm" aria-label="Workspace">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <label className="setup-option">
          <input type="checkbox" checked={session} onChange={(event) => setSession(event.target.checked)} />
          <span>Start a session in it</span>
        </label>

        {mode === "clone" ? (
          <p className="muted">
            git clone runs in a terminal of its own, where git can ask for a passphrase. Once it
            is done the project is added, and the terminal closes; if it fails, the terminal stays to say why.
          </p>
        ) : null}

        {problem ? <p className="setup-error">{problem}</p> : null}

        <div className="setup-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={problem !== null} onClick={submit}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="agents-field">
      <span className="agents-label">{label}</span>
      <span className="agents-control">
        {children}
        {hint ? <span className="muted agents-hint">{hint}</span> : null}
      </span>
    </div>
  );
}
