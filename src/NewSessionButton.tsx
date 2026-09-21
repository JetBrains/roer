import { open } from "@tauri-apps/plugin-dialog";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "./lib/projects";
import type { SessionBrowserState } from "./lib/useSessionBrowser";

export type NewSessionButtonProps = Pick<
  SessionBrowserState,
  | "projects"
  | "openNew"
  | "pickingProjectFor"
  | "cancelProjectPick"
  | "pickProjectForNewSession"
  | "attachNewProjectForNewSession"
>;

/**
 * Lives on the stage's own tab bar rather than the sidebar: a new session
 * always lands under whatever Project or Workspace is selected there, so the
 * control that starts one belongs with the sessions it produces, not with the
 * picker that chose the context.
 */
export function NewSessionButton({
  projects,
  openNew,
  pickingProjectFor,
  cancelProjectPick,
  pickProjectForNewSession,
  attachNewProjectForNewSession,
}: NewSessionButtonProps) {
  const pickedProjects = pickingProjectFor
    ? pickingProjectFor.projects
        .map((id) => projects.find((project) => project.id === id))
        .filter((project): project is Project => project != null)
    : [];

  const attachNewForPicker = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      attachNewProjectForNewSession(picked);
    } else {
      // The dialog was dismissed — nothing was picked, so nothing else in
      // this flow will close the menu for us.
      cancelProjectPick();
    }
  };

  return (
    <DropdownMenu
      open={pickingProjectFor != null}
      onOpenChange={(next) => {
        if (!next) cancelProjectPick();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="primary new-session"
          title="New session (⌘T)"
          onClick={openNew}
        >
          New session <span className="hotkey">⌘T</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {pickedProjects.map((project) => (
          <DropdownMenuItem key={project.id} onSelect={() => pickProjectForNewSession(project.path)}>
            {project.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onSelect={(event) => {
            // The dialog is async and the Workspace it's for only lives in
            // `pickingProjectFor` — letting Radix's default close through
            // here would clear it before the dialog resolves.
            event.preventDefault();
            void attachNewForPicker();
          }}
        >
          Attach a new project…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
