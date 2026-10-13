/* where else a file is edited: the other PRs of the stack, and the other
   commits of a PR, that change it and that the reader isn't looking at now.
   Read from the shell's edit index, which the build makes for every PR
   whether or not anyone authored a review of it, keyed by path - so a row
   looks at its own file's edits and nothing else. */

import {
  activeReview,
  askForCommit,
  commits,
  selectedCommit,
  shell,
  stops,
} from "./payload.ts";
import { type EditCommit, type ShellReview } from "./ReviewPayload.ts";
import { selectCommitAndRemount, switchReview } from "./reviewSwitch.ts";
import { recordCommitInUrl, recordFileInUrl } from "./urlState.ts";

/** one PR the file is also edited in, and which of its commits */
export type EditedPlace = {
  review: ShellReview;
  /** "PR 2/3" - absent when the stack is the one PR, where saying so is noise */
  pr?: string;
  /** the commits, "3/5" each - absent when the PR is the one commit */
  commits: { commit: EditCommit; label: string }[];
};

/** the PRs of the stack, in order - the every-PR review is not one of them */
const layers = (): ShellReview[] => shell.reviews.filter((review) => review.aggregate !== true);

/** whether the every-PR review covers this PR: read commit by commit, it is
    the reviewed PRs' commits; read whole, it is the trunk to the top reviewed
    PR, an unreviewed one below that included */
const inEveryPrReview = (layer: ShellReview): boolean => {
  if (layer.block !== undefined) {
    return true;
  }
  const stack = layers();
  const top = stack.findLastIndex((review) => review.block !== undefined);
  return commits.length === 0 && stack.indexOf(layer) < top;
};

/** whether the page is showing this commit of this PR already */
const inView = (layer: ShellReview, sha: string): boolean => {
  if (activeReview.aggregate === true) {
    return inEveryPrReview(layer) && (selectedCommit === undefined || selectedCommit === sha);
  }
  return layer.key === activeReview.key && (selectedCommit === undefined || selectedCommit === sha);
};

export const alsoEditedIn = (path: string): EditedPlace[] => {
  const index = shell.edits;
  const editing = index?.byPath[path];
  if (index === undefined || editing === undefined) {
    return [];
  }
  const stack = layers();
  const places = new Map<string, EditedPlace>();
  // in stack order already, each PR's commits oldest first
  for (const at of editing) {
    const commit = index.commits[at];
    const review = stack.find((layer) => layer.key === commit?.review);
    if (commit === undefined || review === undefined || inView(review, commit.sha)) {
      continue;
    }
    const place = places.get(review.key) ?? {
      review,
      ...(stack.length > 1 ? { pr: `PR ${stack.indexOf(review) + 1}/${stack.length}` } : {}),
      commits: [],
    };
    if (commit.of > 1) {
      place.commits.push({ commit, label: `${commit.n}/${commit.of}` });
    }
    places.set(review.key, place);
  }
  return [...places.values()];
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
