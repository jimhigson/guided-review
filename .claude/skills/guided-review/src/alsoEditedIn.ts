/* where else a file is edited: the other PRs of the stack, and the other
   commits of a PR, that change it and that the reader isn't looking at now.
   Worked out from each review's `history`, which the build records for every
   PR whether or not anyone authored a review of it. */

import {
  activeReview,
  askForCommit,
  commits,
  selectedCommit,
  shell,
  stops,
} from "./payload.ts";
import { type HistoryCommit, type ShellReview } from "./ReviewPayload.ts";
import { selectCommitAndRemount, switchReview } from "./reviewSwitch.ts";
import { recordCommitInUrl, recordFileInUrl } from "./urlState.ts";

/** one PR the file is also edited in, and which of its commits */
export type EditedPlace = {
  review: ShellReview;
  /** "PR 2/3" - absent when the stack is the one PR, where saying so is noise */
  pr?: string;
  /** the commits, "commit 3/5" each - absent when the PR is the one commit */
  commits: { commit: HistoryCommit; label: string }[];
};

/** the PRs of the stack, in order - the every-PR review is not one of them */
const layers = (): ShellReview[] => shell.reviews.filter((review) => review.aggregate !== true);

/** whether the page is showing this commit of this PR already */
const inView = (layer: ShellReview, sha: string): boolean => {
  if (activeReview.aggregate === true) {
    return selectedCommit === undefined || selectedCommit === sha;
  }
  return layer.key === activeReview.key && (selectedCommit === undefined || selectedCommit === sha);
};

export const alsoEditedIn = (path: string): EditedPlace[] => {
  const stack = layers();
  return stack.flatMap((layer, index) => {
    const history = layer.history ?? [];
    const editing = history
      .map((commit, commitIndex) => ({ commit, label: `${commitIndex + 1}/${history.length}` }))
      .filter(({ commit }) => commit.files.includes(path) && !inView(layer, commit.sha));
    if (editing.length === 0) {
      return [];
    }
    return [
      {
        review: layer,
        ...(stack.length > 1 ? { pr: `PR ${index + 1}/${stack.length}` } : {}),
        commits: history.length > 1 ? editing : [],
      },
    ];
  });
};

/** the url of a file in a review and commit, for a link to open in a new tab */
export const placeHref = (review: ShellReview, sha: string | undefined, path: string): string => {
  const url = new URL(window.location.href);
  url.searchParams.set("review", review.key);
  url.searchParams.set("file", path);
  if (sha === undefined) {
    url.searchParams.delete("commit");
  } else {
    url.searchParams.set("commit", sha);
  }
  return url.toString();
};

/** whether this page can read that commit without leaving the review it is
    on - the every-PR review read commit by commit carries every PR's commits */
const commitHere = (sha: string): boolean =>
  commits.some((commit) => commit.sha === sha) || stops.some((stop) => stop.key === sha);

/**
 * goes to the file in that review and commit (undefined: the whole PR). The
 * remounted page lands on the file the url names, the way a reload does. A
 * commit only a served review's commit bar knows of is asked for, and read
 * once the server has listed it
 */
export const goToPlace = (review: ShellReview, sha: string | undefined, path: string): void => {
  recordFileInUrl(path);
  const stay = sha === undefined ? review.key === activeReview.key : commitHere(sha);
  if (stay) {
    selectCommitAndRemount(sha);
    return;
  }
  const was = activeReview.key;
  recordCommitInUrl(sha);
  switchReview(review.key);
  if (activeReview.key === was) {
    // the switch was refused - unsaved edits the reader chose to keep
    recordCommitInUrl(selectedCommit);
    return;
  }
  askForCommit(sha !== undefined && selectedCommit !== sha ? sha : undefined);
};
