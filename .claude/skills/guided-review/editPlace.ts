/* Where an edit a note asks for lands - the same place the reviewer's own
 * edit from that row would - worked out from the page, the note, and the
 * checkout. Shared by held.ts (which makes the edit there) and reply.ts
 * (which links the reviewer to it).
 */

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export type ShellReview = { key: string; reviewId?: string; head?: string; aggregate?: boolean; block?: unknown };
export type Shell = { reviews: ShellReview[]; edits?: { commits: { sha: string; review: string }[] } };

export const readShell = (html: string): Shell => {
  const shellText = /<script type="application\/json" id="shell">([\s\S]*?)<\/script>/.exec(readFileSync(html, "utf8"))?.[1];
  return JSON.parse(shellText ?? "{}") as Shell;
};

/** the review whose store a notes.json is */
export const reviewOfNotes = (shell: Shell, notes: string, html: string): ShellReview => {
  const review = shell.reviews.find((candidate) => candidate.reviewId === basename(dirname(resolve(notes))));
  if (review === undefined) {
    throw new Error(`${notes} isn't the store of a review in ${html}`);
  }
  return review;
};

/** what the reviewer was reading when they last spoke on the note: a commit,
    "held:<branch>", "working"/"uncommitted"/"staged", or undefined - the PR
    read whole */
export const readingOf = (notes: string, path: string, line: number): string | undefined => {
  const thread = (JSON.parse(readFileSync(notes, "utf8")) as Record<string, { line?: number; messages?: { from?: string; commit?: string }[] }[]>)[path]?.find(
    (note) => note.line === line,
  );
  if (thread === undefined) {
    throw new Error(`there is no note on ${path}:${line}`);
  }
  // the latest thing the reviewer said is where they are now
  return [...(thread.messages ?? [])].reverse().find((message) => message.from !== "agent")?.commit;
};

export type EditPlace =
  /** the checkout's own files - `reading` is what the reviewer was reading */
  | { kind: "disk"; reading: string | undefined }
  /** the held edits of `branch`, against `reading` (a commit, the hold
      itself, or undefined for the PR's last commit) */
  | { kind: "held"; branch: string; reading: string | undefined };

export const editPlaceOf = (repo: string, shell: Shell, review: ShellReview, reading: string | undefined): EditPlace => {
  const checkedOut = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const onDisk = reading === undefined || reading === "uncommitted" || reading === "working";
  if (onDisk && (review.head === undefined || review.head === checkedOut)) {
    return { kind: "disk", reading };
  }
  if (reading === "staged") {
    throw new Error("the note was written reading what is staged, which isn't edited from the page - edit under working, on disk");
  }
  const branch =
    reading?.startsWith("held:") === true ? reading.slice("held:".length)
    : reading !== undefined && !onDisk ?
      (shell.reviews.find((candidate) => candidate.key === shell.edits?.commits.find((commit) => commit.sha === reading)?.review)?.head ?? review.head)
    : review.head;
  if (branch === undefined || review.aggregate === true && reading === undefined) {
    throw new Error("the note was written reading every PR at once - ask the reviewer which PR the edit belongs in");
  }
  return { kind: "held", branch, reading: onDisk ? undefined : reading };
};

/** a link, relative to the page, to a file where an edit to it landed: the
    page reads it in place - held edits on their commit-bar stop */
export const editLink = (shell: Shell, review: ShellReview, place: EditPlace, path: string): string => {
  const params = new URLSearchParams();
  if (place.kind === "disk") {
    params.set("review", review.key);
    if (place.reading !== undefined) {
      params.set("commit", place.reading);
    }
  } else {
    // the PR the hold is on, where the page carries its review
    const own = shell.reviews.find((candidate) => candidate.head === place.branch && candidate.aggregate !== true && candidate.block !== undefined);
    params.set("review", (own ?? review).key);
    params.set("commit", `held:${place.branch}`);
  }
  params.set("file", path);
  return `?${params.toString()}`;
};
