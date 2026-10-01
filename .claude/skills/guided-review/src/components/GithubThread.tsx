import { useState } from "preact/hooks";

import { githubStore, sayOnGithub, whenSaid } from "../github.ts";
import { type GithubThread as Thread } from "../githubTypes.ts";
import { useStore } from "../stores.ts";

/** typed but not sent, so a poll's redraw loses nothing */
const drafts = new Map<string, string>();

/** resolved threads opened by hand, and ones answered from here - a redraw
    must not fold away the reply you just watched land */
const opened = new Set<string>();

const keepThreadOpen = (id: string): void => {
  opened.add(id);
};

export type GithubThreadProps = { thread: Thread };

/**
 * one inline conversation from the PR, shown where it was written. Read-only
 * except for the reply box: everything else about it - resolving, editing -
 * belongs on the forge, and the link goes there.
 */
export const GithubThread = ({ thread }: GithubThreadProps) => {
  useStore(githubStore);
  const [draft, setDraft] = useState(drafts.get(thread.id) ?? "");
  const [sending, setSending] = useState(false);
  // a resolved thread is done with, so it folds down to a line - but it stays
  // in the page: one resolving while you are reading it (or because of what
  // you just said) must not simply vanish
  const [open, setOpen] = useState(() => !thread.resolved || opened.has(thread.id));

  const send = async () => {
    setSending(true);
    const posted = await sayOnGithub(thread.replyTo, draft);
    setSending(false);
    if (posted) {
      drafts.delete(thread.id);
      setDraft("");
      // replying can resolve the thread on the forge; keep it open so the
      // reply is there to see
      keepThreadOpen(thread.id);
    }
  };

  const [first] = thread.comments;
  if (!open) {
    return (
      <div class="gh-thread is-resolved is-folded">
        <button
          type="button"
          class="gh-unfold"
          title="show this resolved thread"
          onClick={() => {
            opened.add(thread.id);
            setOpen(true);
          }}
        >
          <span class="gh-badge">GitHub</span>
          <span class="gh-flag">resolved</span>
          <span class="gh-author">{first?.author ?? ""}</span>
          <span class="gh-folded-line">{(first?.body ?? "").split("\n")[0]}</span>
        </button>
      </div>
    );
  }

  return (
    <div class={`gh-thread ${thread.resolved ? "is-resolved" : ""}`}>
      <div class="gh-thread-head">
        <span class="gh-badge">GitHub</span>
        {thread.outdated && (
          <span class="gh-flag" title="the branch moved on since this was written">
            outdated
          </span>
        )}
        {thread.resolved && <span class="gh-flag">resolved</span>}
        {thread.side === "LEFT" && (
          <span class="gh-flag" title="written against a line this change removes">
            on the old side
          </span>
        )}
        <a class="gh-open" href={thread.url} target="_blank" rel="noreferrer">
          open ↗
        </a>
      </div>
      {thread.comments.map((comment, index) => (
        <div class="gh-comment" key={index}>
          <span class="gh-author">{comment.author}</span>
          <span class="gh-when">{whenSaid(comment.createdAt)}</span>
          <p class="gh-body">{comment.body}</p>
        </div>
      ))}
      <div class="gh-reply">
        <textarea
          rows={2}
          placeholder="Reply on GitHub…"
          value={draft}
          disabled={sending}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            drafts.set(thread.id, event.currentTarget.value);
          }}
        />
        <button type="button" class="save" disabled={sending || draft.trim() === ""} onClick={send}>
          {sending ? "Posting…" : "Reply"}
        </button>
      </div>
    </div>
  );
};
