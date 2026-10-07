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
  /** the page's own last chapter of files that came into scope after the
      review was written - never authored, and rebuilt as the scope changes */
  live?: boolean;
  /** one of the page's own chapters for a stop of the commit bar - the
      reading order filtered to that stop's files - never shown under "all" */
  stop?: boolean;
  /** html */
  blurb?: string;
  items: ReviewItem[];
  /** the commit this chapter reads, when the review is authored per commit -
      the sha of one of the review's own `commits` */
  commit?: string;
  /** which PR of a stack this chapter came from, in the every-PR review -
      what the page bands the reading order by */
  pr?: string;
};

/** the commit bar's last stop, when a review asks for it: what is changed in
    the working tree and not committed at all. Authored as this `ref`, read
    from disk rather than from history - and so the one per-commit view whose
    rows can still be edited */
export const uncommittedRef = "uncommitted";

/** a served review's own last two stops: what is staged (HEAD to the index),
    and what is in the working tree beyond that (the index to the disk) */
export const stagedRef = "staged";
export const workingRef = "working";

/** one stop of a served review's commit bar - a commit of the branch, or the
    staged or working changes - and the files it changes, as the server lists
    them each poll */
export type ReviewStop = {
  key: string;
  /** short: a short sha, or "staged" / "working" */
  label: string;
  subject: string;
  refs: SideRefs;
  files: { path: string; status: string; from?: string; sha?: string }[];
};

/** one commit of a PR, as its own thing to read */
/** one side of a diff, named the way git names it - a branch, a tag, or
    "main~2" - with the commit it is, so the page can say exactly what it is
    comparing. A sha with no name at all is a commit nothing refers to, and
    shows as just that */
export type SideRef = { name: string; sha: string };

/** what a diff's two sides are */
export type SideRefs = { before: SideRef; after: SideRef };

export type ReviewCommit = {
  sha: string;
  short: string;
  subject: string;
  /** the PR this commit belongs to, in the every-PR review */
  pr?: string;
  /** its parent and itself, named - what its rows' diffs are between */
  refs?: SideRefs;
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

/**
 * a block of one side of a file that a move accounts for: lines removed from
 * the "before" side that reappear elsewhere, or lines on the "after" side
 * that arrived from elsewhere - where, is `other`. Everything inside it but
 * `edited` is the same code, give or take indentation, so only those lines
 * (and whatever isn't in a run at all) are new to read
 */
export type MovedRun = {
  side: "before" | "after";
  /** 1-based, inclusive, in that side's own numbering */
  start: number;
  end: number;
  /** the other end of the move: the row it is listed under, and the line its
      block starts on in that row's other side */
  other: { path: string; line: number };
  /** lines inside the run that changed on the way */
  edited: number[];
  /** the parts of those edited lines that did come along - a call rewritten
      around arguments that moved, say. 1-based columns, end exclusive */
  fragments?: { line: number; start: number; end: number }[];
};

export type ReviewPayload = {
  id: string;
  meta: ReviewMeta;
  groups: ReviewGroup[];
  sides: Record<string, Side>;
  /** added and removed line counts, per path */
  stats: Record<string, [number, number]>;
  /** what the review's whole-range diffs are between - a commit's own rows
      say theirs on the commit. Absent from a page built before this */
  refs?: SideRefs;
  /** each file's moved code, keyed as `sides` is - absent for a file with
      none, and for a page built before moves were detected */
  moves?: Record<string, MovedRun[]>;
  /** where each renamed file came from, keyed as `sides` is - absent for a
      page built before renames were followed */
  renamedFrom?: Record<string, string>;
  /** files in the review's scope when it was built that the reading order
      leaves out on purpose - lockfiles, generated code - so a served page,
      showing files that come into scope later, doesn't offer these as new */
  leftOut?: string[];
  links: Record<string, string>;
  images: Record<string, ImageRow>;
  /** absolute path to the repo checkout this review was built from, so a
      file's row can link to a local editor (eg vscode://file/...) */
  repoRoot: string;
  /** the commits this review is read through, oldest first - absent when it
      was authored as one lump, which is every mode but a per-commit PR */
  commits?: ReviewCommit[];
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
  /** what the before side follows, so a served page can keep it current: in
      a PR, the base branch (eg origin/main) the head is measured against at
      their merge base; in a working-tree review, HEAD. When the branch is
      rebased, or a commit lands under a working tree, the server sees the
      base move and the page reads its before side from the new one. Absent
      where the before side is history (a commit) or a page predates it */
  baseRef?: string;
  /** the head commit the review was built at (HEAD, for a working tree) -
      with baseSha, what a served page compares against to know the branch
      has moved and the review needs rebuilding */
  headSha?: string;
  /** an instructions file in the stack directory awaits a contributing agent */
  awaitingContribution?: boolean;
  /** the every-layer-at-once review, which the stack bar offers as a toggle
      rather than as another layer of the chain */
  aggregate?: boolean;
};

/**
 * how a page was built, embedded in it so the server can build it again the
 * same way when the branch or its base moves - a rebuild is the whole review
 * recomputed by the code that built it, not a patch on top of it
 */
export type RebuildRecipe = {
  /** build.ts's arguments as first run, less --groups, --out and --left-out,
      with the head named as its branch and the review's id pinned, so the
      rebuild keeps its notes and ticks */
  args: string[];
  /** the groups json it was built from */
  authored: unknown;
  /** the files the first build found left out of the reading order -
      carried, so a file that came into scope later isn't taken for one */
  leftOut: string[];
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
  /** the commit whose diff this row shows, where the review has commits */
  commit?: string;
};

/** where a file's before/after lives: under its commit when the review is
    read per commit, since the same file reads differently in each */
export const sideKey = (path: string, commit: string | undefined): string =>
  commit === undefined ? path : `${commit}:${path}`;

/** what a tick is against: a file of a commit of a review, not just a file -
    the same file read in two commits is two readings */
export const tickKey = (path: string, commit: string | undefined): string =>
  commit === undefined ? path : `${commit}:${path}`;

/** what serve.ts injects into the page; absent when the page is just a file */
export type ReviewServer = {
  token: string;
  /** the review whose head branch the served checkout has on disk - the only
      one whose editors may save back; absent when no carried review matches */
  editableReviewId?: string;
  /** why no review is editable, when none is - eg the checkout is on another
      branch - for the editors to say instead of just refusing input */
  readOnlyReason?: string;
};

declare global {
  interface Window {
    __reviewServer?: ReviewServer;
  }
}
