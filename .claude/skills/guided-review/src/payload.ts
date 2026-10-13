/* Reads the page's shell and the active review's payload out of the DOM.
 *
 * The page can carry several reviews (a PR stack); exactly one is active at a
 * time. These exports are live bindings onto the active review: selectReview
 * reassigns them, and main.tsx remounts the whole App keyed by review,
 * so every component re-reads them on the next render. Nothing may cache them
 * across a switch.
 */

import {
  type HeldEdits,
  heldKey,
  type ReviewCommit,
  type ReviewFile,
  type ReviewPayload,
  type ReviewShell,
  type ReviewStop,
  type ShellReview,
  sideKey,
  tickKey,
  uncommittedRef,
  workingRef,
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
export let moves: ReviewPayload["moves"];
export let renamedFrom: ReviewPayload["renamedFrom"];
export let leftOut: ReviewPayload["leftOut"];
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
    .filter((file) => file.commit === undefined || file.commit === uncommittedRef || file.commit === workingRef)
    .map((file) => file.path);

/** every chapter of the review; `groups` is only the ones in view */
let allGroups: ReviewPayload["groups"] = [];

export const selectReview = (key: string): void => {
  const { review, block } = carriedReview(key);
  activeReview = review;
  payload = parseBlock<ReviewPayload>(block);
  ({
    id: reviewId,
    meta,
    groups,
    sides,
    stats,
    moves,
    renamedFrom,
    leftOut,
    links,
    images,
    repoRoot,
    conflict,
    packages,
    packageScope,
  } = payload);
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

/* the change as it is now, for the review's own whole-range rows: a listed
   file it no longer covers - reverted, deleted after being added, renamed
   away - is left out of view, and comes back to its place if it returns; a
   listed file reads with the status it has now, so a modification since
   deleted says D */
let notInScope = new Set<string>();
let statusNow = new Map<string, string>();

export const setScopeNow = (gone: Set<string>, status: Map<string, string>): void => {
  notInScope = gone;
  statusNow = status;
  selectCommit(selectedCommit);
};

/** every file the reading order lists for the whole range, in view or not */
export const listedPaths = (): Set<string> =>
  new Set(
    allGroups
      .filter((group) => group.commit === undefined && group.live !== true && group.stop !== true)
      .flatMap((group) => group.items.map((item) => item.path)),
  );

/** read one commit of this review, or all of them (undefined) */
export const selectCommit = (sha: string | undefined): void => {
  selectedCommit = sha;
  // a stop's chapters are that stop's alone: "all" is the review as written
  const chosen =
    sha === undefined ?
      allGroups.filter((group) => group.stop !== true)
    : allGroups.filter((group) => group.commit === sha);
  const inView = chosen
    .map((group) =>
      group.commit !== undefined ? group : (
        {
          ...group,
          items: group.items
            .filter((item) => !notInScope.has(item.path))
            .map((item) => {
              const now = statusNow.get(item.path);
              return now === undefined || now === item.status ? item : { ...item, status: now };
            }),
        }
      ),
    )
    .filter((group) => group.items.length > 0);
  groups = inView;
  files = inView.flatMap((group, groupIndex) =>
    group.items.map((item) => ({
      ...item,
      groupIndex,
      // by what it is, not where it sits: rows leaving and rejoining the view
      // mustn't move open diffs and folds onto their neighbours
      id: sideKey(item.path, group.commit),
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

/** the commit the url asked for as the page loaded, or a link has asked for
    since - kept, because a served review's stops (its commits, staged,
    working) only arrive with the next poll, and selecting the review clears a
    commit it doesn't know of yet from the url */
export let commitAskedFor = commitKeyFromUrl();

/** read this commit once the commit bar knows it - or, called with nothing,
    once it is known, forget it was asked for */
export const askForCommit = (sha: string | undefined): void => {
  commitAskedFor = sha;
};

selectReview(initialReviewKey());

export const liveChapterTitle = "Changed since this review was written";

/** the served review's commit bar, as the server last listed it */
export let stops: ReviewStop[] = [];

/** every PR's held edits, as the server last listed them */
export let holds: HeldEdits[] = [];

/** the held edits this review shows: its own PR's - or, reading every PR,
    all of them */
export const holdsHere = (): HeldEdits[] =>
  activeReview.aggregate === true ? holds : holds.filter((held) => held.branch === activeReview.head);

/** a PR's held edits as a stop of the commit bar */
const heldStop = (held: HeldEdits): ReviewStop => ({
  key: heldKey(held.branch),
  label: "held",
  subject: `edits held after ${held.short}, not committed`,
  refs: { before: { name: held.short, sha: held.anchor }, after: { name: "held edits", sha: "" } },
  files: held.files,
});

/**
 * the stops of the commit bar - a served review's commits, staged and
 * working, and any held edits - as chapters: each reads as the reading order
 * filtered to the files it changes, the review's own chapters in its own
 * order, with whatever it changes beyond them in a chapter of its own. Their
 * sides are the server's to fill, when a stop is first looked at
 */
const composeStops = (): void => {
  allGroups = allGroups.filter((group) => group.stop !== true);
  const authored = allGroups.filter((group) => group.commit === undefined && group.live !== true);
  for (const stop of [...stops, ...holdsHere().map(heldStop)]) {
    const changed = new Map(stop.files.map((file) => [file.path, file]));
    for (const group of authored) {
      const items = group.items.filter((item) => changed.has(item.path));
      if (items.length > 0) {
        allGroups = [
          ...allGroups,
          {
            ...group,
            commit: stop.key,
            stop: true,
            items: items.map((item) => ({ ...item, status: changed.get(item.path)?.status ?? item.status })),
          },
        ];
        for (const item of items) {
          changed.delete(item.path);
        }
      }
    }
    if (changed.size > 0) {
      allGroups = [
        ...allGroups,
        {
          title: "Not in the reading order",
          blurb: "Changed here, but the review as written doesn't read it.",
          commit: stop.key,
          stop: true,
          items: [...changed.values()].map((file) => ({ path: file.path, status: file.status })),
        },
      ];
    }
    for (const file of stop.files) {
      if (file.from !== undefined) {
        renamedFrom = { ...renamedFrom, [sideKey(file.path, stop.key)]: file.from };
      }
    }
  }
  const listed: ReviewCommit[] =
    (payload.commits ?? []).length > 0 ?
      (payload.commits ?? [])
    : stops.map((stop) => ({ sha: stop.key, short: stop.label, subject: stop.subject, refs: stop.refs }));
  // held edits sit right after the commit they were made against
  commits = holdsHere().reduce((bar, held) => {
    const entry = { ...heldStop(held), sha: heldKey(held.branch), short: "held" };
    const at = bar.findIndex((commit) => commit.sha === held.anchor);
    return at === -1 ? [...bar, entry] : [...bar.slice(0, at + 1), entry, ...bar.slice(at + 1)];
  }, listed);
  const still = selectedCommit === undefined || commits.some((commit) => commit.sha === selectedCommit);
  selectCommit(still ? selectedCommit : undefined);
};

export const setStops = (next: ReviewStop[]): void => {
  stops = next;
  composeStops();
};

export const setHolds = (next: HeldEdits[]): void => {
  holds = next;
  composeStops();
};

/**
 * the files that came into the review's scope after it was written, as the
 * page's own last chapter - replaced whole each time, since it is the scope
 * now and not something anyone authored. Their sides and counts must already
 * be in `sides`/`stats`; renamed ones say where from
 */
export const setLiveFiles = (live: { path: string; status: string; from?: string }[]): void => {
  allGroups = allGroups.filter((group) => group.live !== true);
  for (const file of live) {
    if (file.from !== undefined) {
      renamedFrom = { ...renamedFrom, [file.path]: file.from };
    }
  }
  if (live.length > 0) {
    allGroups = [
      ...allGroups,
      {
        title: liveChapterTitle,
        blurb:
          "Not in the reading order yet - the agent hears about each one, and can place it. " +
          "The diffs are live, the same as every other file's.",
        live: true,
        items: live.map((file) => ({ path: file.path, status: file.status })),
      },
    ];
  }
  selectCommit(selectedCommit);
};

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
