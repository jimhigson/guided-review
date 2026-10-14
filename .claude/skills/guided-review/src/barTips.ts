/* what the stack bar and the commit bar say on hover: which PR or commit it
   is, and how big - commits, files, lines added and removed. Read from what
   the build recorded (each PR's size, each commit's place in the edit
   index), and for the served bar's own stops from what the server listed */

import { holds, shell, stats, stops } from "./payload.ts";
import { type ReviewCommit, type ShellReview, heldKey, isHeldKey, sideKey } from "./ReviewPayload.ts";

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const lines = (added: number, removed: number): string => `+${added} −${removed}`;

/** how many files each commit of the edit index changes, by its index there */
let filesPerCommit: Map<number, number> | undefined;
const filesOf = (at: number): number => {
  if (filesPerCommit === undefined) {
    filesPerCommit = new Map();
    for (const commits of Object.values(shell.edits?.byPath ?? {})) {
      for (const index of commits) {
        filesPerCommit.set(index, (filesPerCommit.get(index) ?? 0) + 1);
      }
    }
  }
  return filesPerCommit.get(at) ?? 0;
};

/** a PR of the stack: its name, its place, and its size */
export const prTip = (review: ShellReview, place?: string): string => {
  const { size } = review;
  return [
    review.title === review.label ? review.label : `${review.label}: ${review.title}`,
    place,
    size === undefined ? undefined : (
      `${count(size.commits, "commit")} · ${count(size.files, "file")} · ${lines(size.added, size.removed)}`
    ),
    review.head === undefined || review.head === review.label ? undefined : `branch ${review.head}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
};

/** the lines of a stop's files, as far as the page has read them */
const stopLines = (key: string, paths: string[]): string | undefined => {
  const read = paths.map((path) => stats[sideKey(path, key)]).filter((counts) => counts !== undefined);
  return read.length < paths.length ? undefined : lines(
      read.reduce((total, [added]) => total + added, 0),
      read.reduce((total, [, removed]) => total + removed, 0),
    );
};

/** a commit of the bar - or a stop of a served bar, or the held edits */
export const commitTip = (commit: ReviewCommit): string => {
  if (isHeldKey(commit.sha)) {
    const held = holds.find((entry) => heldKey(entry.branch) === commit.sha);
    const paths = held?.files.map((file) => file.path) ?? [];
    return [
      `edits held after ${held?.short ?? "?"}, not committed`,
      [count(paths.length, "file"), stopLines(commit.sha, paths)].filter((part) => part !== undefined).join(" · "),
      "commit or amend them from the bar below",
    ].join("\n");
  }
  const at = shell.edits?.commits.findIndex((entry) => entry.sha === commit.sha) ?? -1;
  const indexed = at === -1 ? undefined : shell.edits?.commits[at];
  const stop = stops.find((entry) => entry.key === commit.sha);
  const files = indexed !== undefined ? filesOf(at) : stop?.files.length;
  const size =
    indexed?.added !== undefined && indexed.removed !== undefined ? lines(indexed.added, indexed.removed)
    : stop === undefined ? undefined
    : stopLines(stop.key, stop.files.map((file) => file.path));
  return [
    `${commit.short} ${commit.subject}`,
    commit.pr,
    indexed === undefined || indexed.of < 2 ? undefined : `commit ${indexed.n} of ${indexed.of}`,
    [files === undefined ? undefined : count(files, "file"), size].filter((part) => part !== undefined).join(" · ") || undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
};
