import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "roer/ui";

/**
 * Asks for a review of the branch, whose comments land in this tab: from the
 * session on the stage, whichever agent runs there, or from a new session
 * started on it, with the default agent or one picked for it. One short word in the header, so it fits beside the diff's
 * own controls in a narrow tab.
 */
export function ReviewMenu({
  agent,
  onHere,
  onNew,
  onNewWith,
  disabled,
  className = "link",
}: {
  /** Who runs in the session on the stage, for the item that asks it. */
  agent: string;
  /** Asks the session on the stage; absent when nothing there can be asked. */
  onHere?: () => void;
  /** Starts a new session on the review, with the default agent; absent when no agent can be handed a prompt. */
  onNew?: () => void;
  /** The same, asking first which agent; absent with `onNew`. */
  onNewWith?: () => void;
  /** Nothing to review yet. */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${className} review-menu`}
          title="Ask an agent to review the branch and leave its comments here"
          disabled={disabled || (!onHere && !onNew)}
        >
          Review ▾
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!onHere} onSelect={() => onHere?.()}>
          In this session, with {agent}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!onNew} onSelect={() => onNew?.()}>
          In a new session
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!onNewWith} onSelect={() => onNewWith?.()}>
          In a new session, with another agent…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
