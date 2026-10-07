/* takes in the review as the server rebuilt it. When the branch or its base
   moves - a commit, a rebase, an amend - the server builds the review again
   the way it was first built, and the page swaps the new build in on its next
   poll: everything worked out from the branch (sides, counts, moved code,
   renames, images, links) becomes what a fresh load would show, while what
   the reader has done - notes, ticks, open diffs, where they are, unsaved
   edits - stays. A read file whose diff the move changed is no longer read. */

import { type FileFromDisk, liveEditors } from "./liveEditors.ts";
import { fetchFileFromDisk } from "./fileSync.ts";
import {
  activeReview,
  activeReviewIsEditable,
  reviewId,
  selectCommit,
  selectedCommit,
  selectReview,
  server,
  setStops,
  sides,
  stats,
  stops,
} from "./payload.ts";
import { type ShellReview, type Side } from "./ReviewPayload.ts";
import { resetLiveFiles } from "./scopeSync.ts";
import { loadStopSides, resetStops } from "./stopSync.ts";
import { bumpPayloadVersion, toast } from "./stores.ts";
import { markChangedSinceRead } from "./ticks.ts";

/** what the server says the page it serves was built at */
export type ServerBuild = {
  baseSha: string;
  headSha: string | null;
  rebuilding: boolean;
  movedBecause: string;
  /** why the last rebuild failed - the page then still shows the old build */
  failure?: string;
};

type Built = { review: ShellReview; payload: string; images: Record<string, string> };

let inFlight = false;
let toldRebuilding = false;
let toldFailure = "";

/** an inert json block, made or replaced */
const putBlock = (id: string, text: string): void => {
  const existing = document.getElementById(id);
  const block = existing ?? Object.assign(document.createElement("script"), { type: "application/json", id });
  block.textContent = text;
  if (existing === null) {
    document.body.append(block);
  }
};

export const followBuild = async (build: ServerBuild | undefined): Promise<void> => {
  if (server === undefined || build === undefined || build.headSha === null || inFlight) {
    return;
  }
  if (build.rebuilding) {
    if (!toldRebuilding) {
      toldRebuilding = true;
      toast(`the branch moved${build.movedBecause === "" ? "" : ` (${build.movedBecause})`} — rebuilding the review…`);
    }
    return;
  }
  if (build.failure !== undefined && build.failure !== "" && build.failure !== toldFailure) {
    toldFailure = build.failure;
    toldRebuilding = false;
    toast(`couldn't rebuild the review — this is still the old build: ${build.failure}`, "warn");
    return;
  }
  if (build.baseSha === activeReview.baseSha && build.headSha === activeReview.headSha) {
    return;
  }
  inFlight = true;
  try {
    const response = await fetch(`/payload?review=${encodeURIComponent(reviewId)}`).catch(() => undefined);
    if (response?.ok !== true) {
      return;
    }
    const built = (await response.json()) as Built;
    if (built.review.block === undefined) {
      return;
    }
    const before: Record<string, Side> = { ...sides };

    for (const [id, text] of Object.entries(built.images)) {
      putBlock(id, text);
    }
    putBlock(built.review.block, built.payload);
    Object.assign(activeReview, built.review);
    // the same review, read afresh from its new block - the stop in view and
    // the url stay as they were, its stops put back until the next poll
    // lists them again
    const reading = selectedCommit;
    const listed = stops;
    selectReview(activeReview.key);
    resetLiveFiles();
    resetStops();
    if (listed.length > 0) {
      setStops(listed);
      if (reading !== undefined && listed.some((stop) => stop.key === reading)) {
        // its rows can't draw without their sides, which the new payload
        // doesn't carry
        await loadStopSides(reading);
        selectCommit(reading);
      }
    }

    const editable = activeReviewIsEditable();
    for (const [key, side] of Object.entries(sides)) {
      const was = before[key];
      if (was === undefined) {
        continue;
      }
      // the right side of an editable review is the disk, which the move
      // didn't touch - only the left can have changed under the reader there
      if (was.before !== side.before || (!editable && was.after !== side.after)) {
        markChangedSinceRead(key);
      }
      // the build read the committed head; the page had the disk, and keeps
      // it - with counts against the new base for what is really there. An
      // open editor knows the disk better than the snapshot does
      const onDisk = liveEditors.get(key)?.sha() ?? was.sha;
      if (editable && onDisk !== side.sha) {
        const fresh: FileFromDisk | undefined = await fetchFileFromDisk(key);
        sides[key] =
          fresh === undefined ?
            { ...side, after: was.after, sha: onDisk }
          : { ...side, after: fresh.after, sha: fresh.sha };
        if (fresh !== undefined) {
          stats[key] = [fresh.added, fresh.removed];
        }
      }
    }
    for (const [key, editor] of liveEditors) {
      const side = sides[key];
      if (side !== undefined) {
        editor.applyBefore(side.before, stats[key] ?? [0, 0], editable ? undefined : side.after);
        editor.refreshMoves();
      }
    }
    bumpPayloadVersion();
    toast(
      `the branch moved${build.movedBecause === "" ? "" : ` (${build.movedBecause})`} — ` +
        `the review is rebuilt at ${build.headSha.slice(0, 9)}`,
    );
  } finally {
    inFlight = false;
    toldRebuilding = false;
  }
};
