/* keeps the page in step with every PR's held edits - the edits saved from
   the page into a PR and not committed yet - as the server lists them each
   poll. Their own rows on the commit bar get their sides; and the rows they
   were made from (the commit they are held against, or the whole PR when
   they are held against its last commit) show the held content rather than
   the commit's, so editing on from there edits what is held. When edits stop
   being held, those rows go back to what the commit has. */

import { lineCounts } from "./lineCounts.ts";
import { liveEditors } from "./liveEditors.ts";
import { activeReview, activeReviewIsEditable, reviewId, server, setHolds, sides, stats } from "./payload.ts";
import { type HeldEdits, heldKey, type Side, sideKey } from "./ReviewPayload.ts";
import { bumpPayloadVersion, makeStore } from "./stores.ts";

type HeldSide = { before: string; after: string; sha: string; added: number; removed: number };

/** the PRs a commit or amend left on an older head of the PR below them */
export const staleStore = makeStore<string[]>([]);

let signature = "";

/** a rebuild replaced the payload, held rows and all: the next poll's held
    edits are taken in afresh, whatever was taken in before */
export const resetHolds = (): void => {
  signature = "";
  replaced.clear();
};

/** what each row showed before held content replaced it */
const replaced = new Map<string, { side: Side; counts: [number, number] | undefined }>();

const fetchHeldSides = async (held: HeldEdits): Promise<Record<string, HeldSide>> => {
  const response = await fetch(`/held/sides?review=${encodeURIComponent(reviewId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server?.token ?? "" },
    body: JSON.stringify({ branch: held.branch, paths: held.files.map((file) => file.path) }),
  }).catch(() => undefined);
  return response?.ok === true ? ((await response.json()) as Record<string, HeldSide>) : {};
};

/** a row's content now, into the editor showing it - unless that editor has
    edits of its own not yet saved, which win */
const showIn = (key: string, after: string, sha: string, counts: [number, number]): void => {
  const editor = liveEditors.get(key);
  if (editor !== undefined && !editor.isDirty() && editor.sha() !== sha) {
    editor.applyFromDisk({ after, sha, added: counts[0], removed: counts[1] });
  }
};

export const followHolds = async (next: HeldEdits[] | null | undefined, stale: string[] | null | undefined): Promise<void> => {
  if (JSON.stringify(stale ?? []) !== JSON.stringify(staleStore.get())) {
    staleStore.set(stale ?? []);
  }
  if (next === null || next === undefined || server === undefined) {
    return;
  }
  const nextSignature = JSON.stringify(next.map((held) => [held.branch, held.commit]));
  if (nextSignature === signature) {
    return;
  }
  signature = nextSignature;
  const fetched = await Promise.all(next.map(async (held) => ({ held, sides: await fetchHeldSides(held) })));

  // back to the commits' own content, then the held content over it
  const restored = new Map(replaced);
  replaced.clear();
  for (const { held, sides: heldSides } of fetched) {
    for (const [path, side] of Object.entries(heldSides)) {
      const own = sideKey(path, heldKey(held.branch));
      sides[own] = { before: side.before, after: side.after, sha: side.sha };
      stats[own] = [side.added, side.removed];
      showIn(own, side.after, side.sha, [side.added, side.removed]);
      const fromRows = [
        sideKey(path, held.anchor),
        // the whole PR's rows read to its last commit; a review that is the
        // checkout reads them from disk instead, and disk is where they save
        ...(held.tip && held.branch === activeReview.head && !activeReviewIsEditable() ? [path] : []),
      ];
      for (const key of fromRows) {
        const was = restored.get(key) ?? (sides[key] === undefined ? undefined : { side: sides[key], counts: stats[key] });
        if (was === undefined) {
          continue;
        }
        restored.delete(key);
        replaced.set(key, was);
        const counts = lineCounts(was.side.before, side.after);
        sides[key] = { ...was.side, after: side.after, sha: side.sha };
        stats[key] = counts;
        showIn(key, side.after, side.sha, counts);
      }
    }
  }
  for (const [key, was] of restored) {
    sides[key] = was.side;
    if (was.counts !== undefined) {
      stats[key] = was.counts;
    }
    showIn(key, was.side.after, was.side.sha, was.counts ?? [0, 0]);
  }
  setHolds(next);
  bumpPayloadVersion();
};
