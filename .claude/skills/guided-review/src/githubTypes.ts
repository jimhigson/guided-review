/* What a review knows about its PR's comments on the forge. Written by
   prComments.ts into <store>/github.json, served to the page, and read by
   both - so the shapes live here, in a module with no runtime of its own. */

export type GithubComment = {
  author: string;
  /** the comment as written - markdown, rendered as plain text in the page */
  body: string;
  createdAt: string;
  url: string;
};

/** one inline conversation on a line of the diff */
export type GithubThread = {
  /** the thread's node id on the forge */
  id: string;
  /** the first comment's numeric id - what a reply is posted against */
  replyTo: number;
  path: string;
  /** the line it sits on now. Absent when the thread is outdated: the branch
      moved on and the forge no longer knows where it belongs */
  line?: number;
  /** RIGHT is the changed side, LEFT a line the change removed */
  side: "LEFT" | "RIGHT";
  outdated: boolean;
  resolved: boolean;
  url: string;
  comments: GithubComment[];
};

export type GithubVerdict = GithubComment & {
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED */
  state: string;
};

/** one review's PR, as the forge has it */
export type GithubReview = {
  pr: number;
  url: string;
  title: string;
  /** OPEN, CLOSED, MERGED */
  state: string;
  /** when this was last read from the forge */
  fetchedAt: string;
  threads: GithubThread[];
  /** the PR's own conversation, tied to no line */
  conversation: GithubComment[];
  /** each review left on the PR, with what it decided */
  verdicts: GithubVerdict[];
};

export const unresolvedThreads = (github: GithubReview | undefined): GithubThread[] =>
  (github?.threads ?? []).filter((thread) => !thread.resolved);

/** threads that belong against a line of the changed side, and so can sit in
    the editor where they were written */
export const threadsOnLine = (
  threads: GithubThread[],
  path: string,
): (GithubThread & { line: number })[] =>
  threads.filter(
    (thread): thread is GithubThread & { line: number } =>
      thread.path === path && thread.side === "RIGHT" && thread.line !== undefined,
  );

/** threads about a file that have nowhere to sit in it: outdated, or about a
    line the change removed */
export const threadsOffLine = (threads: GithubThread[], path: string): GithubThread[] =>
  threads.filter(
    (thread) =>
      thread.path === path && (thread.side === "LEFT" || thread.line === undefined),
  );
