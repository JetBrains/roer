import { useEffect, useState } from "react";
import { defineExtension, gitChanges, useActive, useScope } from "roer";

interface Row {
  name: string;
  path: string;
  /** null when the folder is gone or no longer a repository. */
  branch: string | null;
  files: number;
  added: number;
  deleted: number;
}

/** Each project of the Workspace or the one Project: where it is, and what is not committed. */
function Repositories() {
  const scope = useScope();
  const active = useActive();
  const [rows, setRows] = useState<Row[] | null>(null);

  // Read again whenever the Workspace tab comes back on top: what the agents
  // changed meanwhile shows then, with no polling while it is out of sight.
  useEffect(() => {
    if (!scope || !active) return;
    let cancelled = false;
    void Promise.all(
      scope.projects.map(async ({ name, path }): Promise<Row> => {
        const changes = await gitChanges(path).catch(() => null);
        const files = changes?.files ?? [];
        return {
          name,
          path,
          branch: changes ? changes.branch || changes.commit || "no commits" : null,
          files: files.length,
          added: files.reduce((sum, file) => sum + file.added, 0),
          deleted: files.reduce((sum, file) => sum + file.deleted, 0),
        };
      }),
    ).then((read) => {
      if (!cancelled) setRows(read);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, active]);

  if (!scope) return null;
  if (scope.projects.length === 0) return <p className="muted">No projects here yet.</p>;
  if (!rows) return <p className="muted">Reading…</p>;
  return (
    <ul className="repositories" data-roer-id="list">
      {rows.map((row) => (
        <li key={row.path} title={row.path} data-roer-id={row.name}>
          <span className="repositories-name">{row.name}</span>
          {row.branch === null ? (
            <span className="muted">not found</span>
          ) : (
            <>
              <span className="muted">{row.branch}</span>
              {row.files > 0 ? (
                <span className="counts">
                  {row.files} uncommitted <span className="plus">+{row.added}</span>{" "}
                  <span className="minus">−{row.deleted}</span>
                </span>
              ) : (
                <span className="muted">clean</span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export default defineExtension((roer) => {
  roer.workspace.registerSection({ id: "list", title: "Repositories", component: Repositories });
});
