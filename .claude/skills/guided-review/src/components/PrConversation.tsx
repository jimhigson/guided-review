import { useState } from "preact/hooks";

import { githubStore, sayOnGithub, whenSaid } from "../github.ts";
import { useStore } from "../stores.ts";

const verdictWords: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "asked for changes",
  COMMENTED: "commented",
  DISMISSED: "review dismissed",
};

/**
 * what the PR itself says: its reviews' verdicts and the conversation on it,
 * with a box to answer. Inline threads are not here - they belong on their
 * line, where the code they are about is.
 */
export const PrConversation = () => {
  const github = useStore(githubStore);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);

  if (github === undefined) {
    return null;
  }

  const unresolved = github.threads.filter((thread) => !thread.resolved).length;
  const resolved = github.threads.length - unresolved;
  const say = async () => {
    setSending(true);
    const posted = await sayOnGithub(undefined, draft);
    setSending(false);
    if (posted) {
      setDraft("");
    }
  };

  return (
    <section class="pr-talk">
      <button
        type="button"
        class="pr-talk-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="gh-badge">GitHub</span>
        <a
          class="pr-talk-number"
          href={github.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          #{github.pr} ↗
        </a>
        <span class="pr-talk-counts">
          {unresolved} unresolved {unresolved === 1 ? "thread" : "threads"}
          {resolved > 0 && ` (${resolved} resolved)`},{" "}
          {github.conversation.length} {github.conversation.length === 1 ? "comment" : "comments"},{" "}
          {github.verdicts.length} {github.verdicts.length === 1 ? "review" : "reviews"}
        </span>
        <span class="pr-talk-when">read {whenSaid(github.fetchedAt)}</span>
      </button>

      {open && (
        <div class="pr-talk-body">
          {github.verdicts.map((verdict, index) => (
            <div class="gh-comment" key={`v${index}`}>
              <span class="gh-author">{verdict.author}</span>
              <span class={`gh-verdict verdict-${verdict.state}`}>
                {verdictWords[verdict.state] ?? verdict.state.toLowerCase()}
              </span>
              <span class="gh-when">{whenSaid(verdict.createdAt)}</span>
              {verdict.body !== "" && <p class="gh-body">{verdict.body}</p>}
            </div>
          ))}
          {github.conversation.map((comment, index) => (
            <div class="gh-comment" key={`c${index}`}>
              <span class="gh-author">{comment.author}</span>
              <span class="gh-when">{whenSaid(comment.createdAt)}</span>
              <p class="gh-body">{comment.body}</p>
            </div>
          ))}
          <div class="gh-reply">
            <textarea
              rows={2}
              placeholder="Comment on the PR…"
              value={draft}
              disabled={sending}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <button
              type="button"
              class="save"
              disabled={sending || draft.trim() === ""}
              onClick={say}
            >
              {sending ? "Posting…" : "Comment"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
