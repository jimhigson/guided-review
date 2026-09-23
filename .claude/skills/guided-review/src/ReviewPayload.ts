/* the shapes build.ts embeds in the page, and the page reads back out of it.
   No runtime code lives here - build.ts imports these types directly under
   plain node, and a module with side effects (payload.ts reads the DOM) would
   execute on import even when only its types are wanted. */

export type FileStatus = "A" | "D" | "M" | "R";

export type ReviewItem = {
  path: string;
  status: string;
  /** why this file is here and what to look at, as html */
  note?: string;
  /** reviewing a whole stack at once: which of its PRs changed this file, in
      stack order. Absent in a single PR's own review, where every file is
      that PR's by definition */
  layers?: {
    /** its place in the stack, as the page says it: "PR 2/3" */
    label: string;
    /** which PR that is - a number, or the branch of one not pushed yet */
    name: string;
  }[];
};

export type ReviewGroup = {
  title: string;
  /** html */
  blurb?: string;
  items: ReviewItem[];
};

export type ReviewMeta = {
  title: string;
  headerTitle?: string;
  eyebrow?: string;
  /** html */
  lede?: string;
  /** html, each */
  facts?: string[];
  /** html */
  footer?: string;
};

/** a file's whole before and after, for the diff editor to work from */
export type Side = {
  before: string;
  after: string;
  /** what the modified side hashed to when the review was built */
  sha: string;
  /** a conflict review's incoming side - `before` is then the current side
      and `after` the resolution */
  incoming?: string;
  /** a conflict review's common ancestor of current and incoming */
  ancestor?: string;
  /** where the file was on the current side, when a move on the other side
      means that isn't where the resolution has it */
  currentPath?: string;
  /** likewise for the incoming side */
  incomingPath?: string;
};

/** why a file is in a conflict review: git could not merge it on its own, or
    it merged cleanly (or wasn't touched) and the resolver changed it anyway */
export type ConflictFileKind = "conflicted" | "edited";

export type ConflictSideLabel = {
  /** short, for the pane heading - a branch name or short sha */
  label: string;
  /** what the side is, for the heading's tooltip */
  detail: string;
};

/** a conflict-resolution review: what was being combined, and how */
export type ConflictInfo = {
  operation: string;
  current: ConflictSideLabel;
  incoming: ConflictSideLabel;
  files: Record<string, ConflictFileKind>;
};

/** one comparable version of an image file */
export type ImageVersion = {
  /** short chooser label, eg "production", "main", "branch" */
  label: string;
  /** what the label resolved to, shown as the chooser tooltip */
  description: string;
  /** index into the row's blob block; byte-identical versions share one */
  blob: number;
  bytes: number;
};

/**
 * an image file's comparable versions. The data uris live in their own inert
 * json block (`block` names its element), parsed only when the row needs them,
 * so evaluating the payload never touches image data. An empty `versions`
 * means the image was left out of the page by the --max-images cap.
 */
export type ImageRow = {
  block: string;
  /** oldest first - the chooser's column order */
  versions: ImageVersion[];
  /** index into versions: the default "from" side of the comparison */
  from: number;
  /** index into versions: the default "to" side of the comparison */
  to: number;
};

export type ReviewPayload = {
  id: string;
  meta: ReviewMeta;
  groups: ReviewGroup[];
  sides: Record<string, Side>;
  /** added and removed line counts, per path */
  stats: Record<string, [number, number]>;
  links: Record<string, string>;
  images: Record<string, ImageRow>;
  /** absolute path to the repo checkout this review was built from, so a
      file's row can link to a local editor (eg vscode://file/...) */
  repoRoot: string;
  /** present only for a conflict-resolution review - it is what enables the
      3-way view */
  conflict?: ConflictInfo;
  /** every package holding a file in the review, as its directory (relative
      to the repo root, never the root itself) to the name its package.json
      gives it - so a monorepo's paths read from their package, not the root.
      Absent from a page built before packages were shown */
  packages?: Record<string, string>;
  /** the npm scope (eg "@shop") when every package in the repo shares it -
      the page then leaves it off the package chips, since it tells them
      apart from nothing */
  packageScope?: string;
};

/**
 * one review the page carries - or, in a PR stack, knows of without carrying:
 * a stack sibling whose review nobody has authored yet has no `block`
 */
export type ShellReview = {
  /** what identifies this review in the page - its block id, the url it
      records, what the stack bar switches to. A PR's number as a string, or a
      local stack branch's name as a slug: a stack of branches nobody has
      pushed has no numbers to go by */
  key: string;
  /** what the stack bar shows for it: "#34" for a PR, the branch for a layer
      that is only local */
  label: string;
  title: string;
  /** the PR page on the forge - empty when there is nothing there yet */
  url: string;
  /** element id of the inert block holding this review's ReviewPayload */
  block?: string;
  /** the review's store id - its ticks and notes directory */
  reviewId?: string;
  /** head branch name, so the server can tell which review edits its checkout */
  head?: string;
  /** the commit this review's diff is measured from - a served page's live
      "did this change" line counts diff against this, not the working
      checkout's index, so they read against the same base the review itself
      does regardless of what else has since been committed there. Absent for
      an uncarried stack sibling, or a page built before this existed */
  baseSha?: string;
  /** an instructions file in the stack directory awaits a contributing agent */
  awaitingContribution?: boolean;
  /** the every-layer-at-once review, which the stack bar offers as a toggle
      rather than as another layer of the chain */
  aggregate?: boolean;
};

/**
 * what the page parses before any review: every review it knows about, in
 * stack order (a plain un-stacked review is a list of one), and which to show
 * first
 */
export type ReviewShell = {
  reviews: ShellReview[];
  /** the `key` of the review shown first */
  current: string;
};

/** a file in reading order, carrying where it sits in the document */
export type ReviewFile = ReviewItem & {
  groupIndex: number;
  id: string;
};

/** what serve.ts injects into the page; absent when the page is just a file */
export type ReviewServer = {
  token: string;
  /** the review whose head branch the served checkout has on disk - the only
      one whose editors may save back; absent when no carried review matches */
  editableReviewId?: string;
};

declare global {
  interface Window {
    __reviewServer?: ReviewServer;
  }
}
