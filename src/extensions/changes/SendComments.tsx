import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "roer/ui";

import { ready, undecided, type LocalComment } from "./local";
import { targetLabel, targetName, type Target } from "./targets";

/**
 * Sends the decided comments, to the first of `targets`, the button saying
 * which, or from the chevron to one of the others, when there are others. Deciding is apart from it:
 * "Accept the rest" only accepts, and what is still undecided stays here.
 * Nothing at all until there is a comment to send or to decide on.
 */
export function SendComments({
  comments,
  targets,
  stagePane,
  disabled,
  always = false,
  onSend,
  onAcceptRest,
  onShowOpen,
}: {
  comments: readonly LocalComment[];
  /** Where they can go, the default first; empty when nowhere. */
  targets: readonly Target[];
  /** The stage's session, which the labels call "this session". */
  stagePane?: string;
  /** Sending now. */
  disabled: boolean;
  /** Send stays in its place, disabled, with nothing to send. */
  always?: boolean;
  onSend: (target: Target) => void;
  onAcceptRest: () => void;
  /** Shows the first comment still to decide, where the diff can. */
  onShowOpen?: () => void;
}) {
  const decided = ready(comments).length;
  const open = undecided(comments).length;
  if (decided === 0 && open === 0 && !always) return null;
  const [first, ...others] = targets;
  const off = disabled || decided === 0 || !first;
  const count = decided === 1 ? "1 comment" : `${decided} comments`;
  return (
    <>
      {open > 0 ? (
        <>
          {onShowOpen ? (
            <button
              type="button"
              className="link send-open"
              title="Go to the first comment you have not accepted, declined or answered yet; Send leaves them here"
              onClick={onShowOpen}
            >
              {open} to decide
            </button>
          ) : (
            <span className="muted send-open" title="The agent's comments you have not accepted, declined or answered yet; Send leaves them here">
              {open} to decide
            </span>
          )}
          <button type="button" className="link" title="Accept every comment not decided yet; nothing is sent" onClick={onAcceptRest}>
            Accept the rest
          </button>
        </>
      ) : null}
      <span className={others.length > 0 ? "split-button send-comments" : "send-comments"}>
        <button
          type="button"
          className="gen-button primary"
          title={first ? `Send ${count} to ${targetName(first, stagePane)}` : "No session with an agent to send them to"}
          onClick={() => first && onSend(first)}
          disabled={off}
        >
          Send {decided}
          {first ? ` to ${targetLabel(first, stagePane)}` : ""}
        </button>
        {/* Only the other places: the button is the first. Without any, the button is all there is. */}
        {others.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="gen-button primary chevron" aria-label="Send to…" title="Send them to another session" disabled={off}>
                ▾
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Send {count} instead to</DropdownMenuLabel>
              {others.map((target) => (
                <DropdownMenuItem key={target.pane} onSelect={() => onSend(target)}>
                  {capital(targetName(target, stagePane))}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </span>
    </>
  );
}

const capital = (text: string): string => text[0].toUpperCase() + text.slice(1);
