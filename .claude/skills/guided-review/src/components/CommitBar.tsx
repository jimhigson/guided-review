import { useEffect, useRef } from "preact/hooks";

import { commits, selectedCommit } from "../payload.ts";
import { uncommittedRef } from "../ReviewPayload.ts";
import { selectCommitAndRemount } from "../reviewSwitch.ts";
import { keepCurrentInView } from "./barScroll.ts";

/**
 * The commits of this PR, under the stack bar: a PR is a chain of commits the
 * way a stack is a chain of PRs, and reading one commit at a time is how the
 * change was written. "all" reads every commit in order, each under its own
 * heading, and is where a review starts - the PR as a whole is still the
 * thing being reviewed.
 */
export const CommitBar = () => {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => keepCurrentInView(bar.current), []);

  if (commits.length < 2) {
    return null;
  }

  return (
    <nav class="commit-bar bar-scrolls" aria-label="Commits in this PR" ref={bar}>
      <span class="bar-pinned">
        <span class="commit-label">commits</span>
        <button
          type="button"
          class={`commit-step ${selectedCommit === undefined ? "is-current" : ""}`}
          aria-pressed={selectedCommit === undefined}
          disabled={selectedCommit === undefined}
          title="every commit, in order"
          onClick={() => selectCommitAndRemount(undefined)}
        >
          all
        </button>
      </span>
      {commits.map((commit) => (
        <button
          type="button"
          key={commit.sha}
          class={`commit-step ${selectedCommit === commit.sha ? "is-current" : ""}`}
          aria-pressed={selectedCommit === commit.sha}
          disabled={selectedCommit === commit.sha}
          title={`${commit.short} ${commit.subject}${commit.pr === undefined ? "" : ` — ${commit.pr}`}`}
          onClick={() => selectCommitAndRemount(commit.sha)}
        >
          <span class={`commit-sha ${commit.sha === uncommittedRef ? "is-uncommitted" : ""}`}>
            {commit.short}
          </span>
          {commit.sha !== uncommittedRef && <span class="commit-subject">{commit.subject}</span>}
        </button>
      ))}
    </nav>
  );
};
