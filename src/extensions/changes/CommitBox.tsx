import { useEffect, useState } from "react";
import { gitCommitAll, onCommitDraft } from "roer";
import { Button } from "roer/ui";

import { commitDraftPrompt } from "./local";

export interface CommitBoxProps {
  /** The repository whose worktree is committed. */
  root: string;
  /** The session's pane, which a drafted message comes back tagged with. */
  pane?: string;
  /** Types a prompt into the session; without it there is no agent to draft the message. */
  send?: (text: string) => Promise<void>;
  agent: string;
  /** Comments on the uncommitted changes that have not gone to the agent: committing buries them. */
  unsent: number;
  /** The commit is made; its short hash. */
  onCommitted: (short: string) => void;
  /** A prompt went to the session; show it. */
  onSent?: () => void;
}

/**
 * Commits what the local changes show, all of it, new files included. With
 * no message, Commit asks the agent for one first and fills it in, to be read
 * before it is committed; nothing is committed on a message nobody has seen.
 */
export function CommitBox({ root, pane, send, agent, unsent, onCommitted, onSent }: CommitBoxProps) {
  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Asked once whether to commit over comments that have not been sent. */
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const unlisten = onCommitDraft((record) => {
      if (record.pane !== pane) return;
      const { title, body } = record.draft;
      setMessage(body.trim() ? `${title.trim()}\n\n${body.trim()}` : title.trim());
      setDrafting(false);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [pane]);

  const draft = async () => {
    if (!send || !pane) return;
    setError(null);
    try {
      await send(commitDraftPrompt(pane));
      setDrafting(true);
      onSent?.();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const commit = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const short = await gitCommitAll(root, message);
      setMessage("");
      onCommitted(short);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const press = () => {
    if (!message.trim()) return void draft();
    if (unsent > 0 && !confirming) return setConfirming(true);
    void commit();
  };

  const canDraft = Boolean(send && pane);
  return (
    <div className="commit-box">
      <div className="commit-box-row">
        <textarea
          aria-label="Commit message"
          rows={message.includes("\n") ? 4 : 1}
          placeholder={canDraft ? `Commit message (leave empty and ${agent} writes it)` : "Commit message"}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setConfirming(false);
          }}
        />
        {canDraft ? (
          <Button onClick={() => void draft()} disabled={busy || drafting}>
            {drafting ? `Waiting for ${agent}…` : `Draft with ${agent}`}
          </Button>
        ) : null}
        <Button variant="primary" onClick={press} disabled={busy || drafting || (!message.trim() && !canDraft)}>
          {busy ? "Committing…" : confirming ? "Commit anyway" : "Commit"}
        </Button>
      </div>
      {confirming ? (
        <p className="notice">
          {unsent === 1 ? "A comment on these changes has" : `${unsent} comments on these changes have`} not been sent
          to {agent}. Committing leaves {unsent === 1 ? "it" : "them"} on lines that are no longer uncommitted.
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
