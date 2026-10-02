/* Reads the page's shell and the active review's payload out of the DOM.
 *
 * The page can carry several reviews (a PR stack); exactly one is active at a
 * time. These exports are live bindings onto the active review: selectReview
 * reassigns them, and main.tsx remounts the whole App keyed by review,
 * so every component re-reads them on the next render. Nothing may cache them
 * across a switch.
 */

import {
  type ReviewCommit,
  type ReviewFile,
  type ReviewPayload,
  type ReviewShell,
  type ShellReview,
  sideKey,
  tickKey,
  uncommittedRef,
} from "./ReviewPayload.ts";
import { commitKeyFromUrl, recordCommitInUrl, recordReviewInUrl, reviewKeyFromUrl } from "./urlState.ts";

const parseBlock = <Parsed,>(elementId: string): Parsed => {
  const element = document.getElementById(elementId);
  if (element === null) {
    throw new Error(`the page carries no ${elementId} block - rebuild it with the current build.ts`);
  }
  return JSON.parse(element.textContent ?? "{}") as Parsed;
};

export const shell = parseBlock<ReviewShell>("shell");

export const server = window.__reviewServer;

const carriedReview = (key: string): { review: ShellReview; block: string } => {
  const review = shell.reviews.find((candidate) => candidate.key === key);
  if (review === undefined || review.block === undefined) {
    throw new Error(`the page carries no review ${key}`);
  }
  return { review, block: review.block };
};

export let activeReview: ShellReview;
export let payload: ReviewPayload;
export let reviewId: string;
export let meta: ReviewPayload["meta"];
export let groups: ReviewPayload["groups"];
export let sides: ReviewPayload["sides"];
export let stats: ReviewPayload["stats"];
export let links: ReviewPayload["links"];
export let images: ReviewPayload["images"];
export let repoRoot: ReviewPayload["repoRoot"];
export let conflict: ReviewPayload["conflict"];
export let packages: ReviewPayload["packages"];
export let packageScope: ReviewPayload["packageScope"];
export let files: ReviewFile[];
export let total: number;
/** every commit of this review, oldest first - empty unless it was authored
    commit by commit */
export let commits: ReviewCommit[] = [];
/** the commit being read, or undefined for all of them, which is the default:
    a stack of commits is still one change, and reading it whole is the usual
    way round */
export let selectedCommit: string | undefined;
/** which commits touch a path, so ticking it while reading them all can tick
    it in each */
let commitsByPath = new Map<string, string[]>();

/** where a file's before/after, stats, link and image live */
export const fileKey = (file: { path: string; commit?: string }): string =>
  sideKey(file.path, file.commit);

/** what ticking this row marks as read */
export const tickKeyOf = (file: { path: string; commit?: string }): string =>
  tickKey(file.path, file.commit);

/** every key ticking this row should mark: reading all the commits at once,
    a file read in one of them is read in all of them */
export const tickKeysOf = (file: ReviewFile): string[] => {
  if (file.commit === undefined || selectedCommit !== undefined) {
    return [tickKeyOf(file)];
  }
  return (commitsByPath.get(file.path) ?? [file.commit]).map((commit) =>
    tickKey(file.path, commit),
  );
};

/** the files a served checkout can keep in step: a commit's diff is history,
    and nothing on disk is that file as that commit had it */
export const diskSyncPaths = (): string[] =>
  files
    .filter((file) => file.commit === undefined || file.commit === uncommittedRef)
    .map((file) => file.path);

/** every chapter of the review; `groups` is only the ones in view */
let allGroups: ReviewPayload["groups"] = [];

export const selectReview = (key: string): void => {
  const { review, block } = carriedReview(key);
  activeReview = review;
  payload = parseBlock<ReviewPayload>(block);
  ({ id: reviewId, meta, groups, sides, stats, links, images, repoRoot, conflict, packages, packageScope } = payload);
  allGroups = payload.groups;
  commits = payload.commits ?? [];
  commitsByPath = new Map();
  for (const group of groups) {
    if (group.commit === undefined) {
      continue;
    }
    for (const item of group.items) {
      commitsByPath.set(item.path, [
        ...(commitsByPath.get(item.path) ?? []),
        group.commit,
      ]);
    }
  }
  recordReviewInUrl(key);
  const wanted = commitKeyFromUrl();
  selectCommit(wanted !== undefined && commits.some((commit) => commit.sha === wanted) ? wanted : undefined);
};

/** read one commit of this review, or all of them (undefined) */
export const selectCommit = (sha: string | undefined): void => {
  selectedCommit = sha;
  const inView = sha === undefined ? allGroups : allGroups.filter((group) => group.commit === sha);
  groups = inView;
  files = inView.flatMap((group, groupIndex) =>
    group.items.map((item, itemIndex) => ({
      ...item,
      groupIndex,
      id: `${groupIndex}-${itemIndex}`,
      ...(group.commit === undefined ? {} : { commit: group.commit }),
    })),
  );
  total = files.length;
  recordCommitInUrl(sha);
};

const isCarried = (key: string): boolean =>
  shell.reviews.find((review) => review.key === key)?.block !== undefined;

// a url naming a carried review wins - it's what a reload or a shared link
// asks for. Otherwise stacks read base-first; shell.current is just the
// build's anchor
const initialReviewKey = (): string => {
  const requested = reviewKeyFromUrl();
  if (requested !== undefined && isCarried(requested)) {
    return requested;
  }
  const [base] = shell.reviews;
  return base !== undefined && base.block !== undefined ? base.key : shell.current;
};

selectReview(initialReviewKey());

/** whether the active review's editors may write to the served checkout */
export const activeReviewIsEditable = (): boolean =>
  server !== undefined && server.editableReviewId === reviewId;

/** git's own words for its diff status letters (eg `git diff --diff-filter`) -
    so the single-letter chip and the full-word chip always agree, since the
    letter is just this word's initial */
export const statusLabel: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
};

export const filesInGroup = (groupIndex: number): ReviewFile[] =>
  files.filter((file) => file.groupIndex === groupIndex);
