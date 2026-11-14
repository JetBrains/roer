import { Check, ChevronDown, Crosshair, Pin } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A live session as the chip offers it. */
export interface ChipSession {
  /** The session's id, which a pin is kept by. */
  id: string;
  pane: string;
  /** What it is doing, as its row in the sidebar names it. */
  name: string;
  /** The Project it is in, or where it runs. */
  group: string;
  agent?: string | null;
  /** The branch its checkout is on, or the commit when there is none. */
  branch?: string | null;
  /** Where it is open in the window. */
  where?: "stage" | "beside";
  changes?: { added: number; deleted: number } | null;
}

export interface SessionChipProps {
  /**
   * `following`: the tab shows the active session and can be pinned.
   * `pinned`: the tab is pinned to `current` and can follow again.
   * `copy`: another copy of the tab, always about `current`, pointed elsewhere.
   */
  mode: "following" | "pinned" | "copy";
  /** The session the tab shows now. */
  current: ChipSession | undefined;
  /** The tab's name, for the menu's words. */
  tab: string;
  sessions: readonly ChipSession[];
  onFollow?: () => void;
  onPin: (session: ChipSession) => void;
  /** Another copy of the tab, in a pane of its own, about `session`. */
  onCopy?: (session: ChipSession) => void;
  onOpenChange?: (open: boolean) => void;
}

const WHERE: Record<NonNullable<ChipSession["where"]>, string> = { stage: "on the stage", beside: "beside" };

/** A session in two lines: what it does, then who runs it on which branch of what. */
function SessionLine({ one, checked }: { one: ChipSession; checked: boolean }) {
  const detail = [one.agent, one.branch, one.group].filter(Boolean).join(" · ");
  return (
    <span className="chip-row">
      <span className="chip-check" aria-hidden="true">
        {checked ? <Check size={12} /> : null}
      </span>
      <span className="chip-main">
        <span className="chip-name">{one.name}</span>
        {detail ? <span className="chip-detail">{detail}</span> : null}
      </span>
      <span className="chip-side">
        {one.where ? <span className="chip-where">{WHERE[one.where]}</span> : null}
        {one.changes && (one.changes.added > 0 || one.changes.deleted > 0) ? (
          <span className="chip-counts">
            <span className="plus">+{one.changes.added}</span> <span className="minus">−{one.changes.deleted}</span>
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Which session a tab is about, and the way to change it: in the header of
 * every tab that needs a session, on the stage or in a pane of its own.
 */
export function SessionChip({ mode, current, tab, sessions, onFollow, onPin, onCopy, onOpenChange }: SessionChipProps) {
  const pinned = mode !== "following";
  const others = sessions.filter((one) => one.id !== current?.id);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={pinned ? "session-chip pinned" : "session-chip"}
          aria-label={`${pinned ? "Pinned to" : "Following"} ${current?.name ?? "no session"}`}
          title={
            mode === "following"
              ? `${tab} follows the session you work in: ${current?.name ?? "none"}`
              : `${tab} stays on ${current?.name ?? "a session that ended"}`
          }
        >
          {pinned ? <Pin size={11} aria-hidden="true" /> : <Crosshair size={11} aria-hidden="true" />}
          <span className="session-chip-mode">{pinned ? "Pinned" : "Following"}</span>
          <span className="session-chip-name">{current?.name ?? "no session"}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="session-chip-menu">
        {mode !== "copy" && onFollow ? (
          <>
            <DropdownMenuItem onSelect={onFollow} disabled={mode === "following"} aria-label="Follow the session you work in">
              <span className="chip-row">
                <span className="chip-check" aria-hidden="true">
                  {mode === "following" ? <Check size={12} /> : <Crosshair size={12} />}
                </span>
                <span className="chip-main">
                  <span className="chip-name">Follow the session you work in</span>
                  <span className="chip-detail">Switches whenever you click into another terminal</span>
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="chip-heading">{mode === "copy" ? "Show" : "Pin to"}</DropdownMenuLabel>
        {sessions.map((one) => {
          const checked = pinned && one.id === current?.id;
          return (
            <DropdownMenuItem
              key={one.id}
              disabled={checked}
              onSelect={() => onPin(one)}
              aria-label={`${mode === "copy" ? "Show" : "Pin to"} ${one.name}`}
            >
              <SessionLine one={one} checked={checked} />
            </DropdownMenuItem>
          );
        })}
        {onCopy && others.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="chip-heading">Open another {tab} for</DropdownMenuLabel>
            {others.map((one) => (
              <DropdownMenuItem key={one.id} onSelect={() => onCopy(one)} aria-label={one.name}>
                <SessionLine one={one} checked={false} />
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <p className="chip-hint">Only sessions open in this window. For another, search for “{tab} for” and its name.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
