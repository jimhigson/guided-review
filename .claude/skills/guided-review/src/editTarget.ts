/* where a row's edits are saved. The served checkout's own rows - the review
   whose branch it has checked out, read whole, or its uncommitted and working
   changes - save to disk, as files. Every other row of any PR saves into that
   PR's held edits on the server: against the commit the row reads, or the
   PR's last commit for a row read across the whole PR. What is staged, and
   the every-PR review read whole (which PR would an edit be?), are read-only;
   so is everything with no server behind the page. */

import { activeReview, activeReviewIsEditable, holds, server } from "./payload.ts";
import { isHeldKey, stagedRef, uncommittedRef, workingRef } from "./ReviewPayload.ts";

export type SaveTarget =
  | { kind: "disk" }
  | {
      kind: "held";
      /** the commit the edit is made against; absent for the PR's last */
      commit?: string;
      /** what the row diffs from, which its counts are measured against */
      row: "commit" | "range" | "held";
      /** the PR the edits are held for, where the page knows it */
      branch?: string;
    };

export const saveTargetOf = (commit: string | undefined): SaveTarget | undefined => {
  if (server === undefined) {
    return undefined;
  }
  const onDisk = commit === undefined || commit === uncommittedRef || commit === workingRef;
  if (onDisk && activeReviewIsEditable()) {
    return { kind: "disk" };
  }
  if (commit === stagedRef || commit === uncommittedRef || commit === workingRef) {
    return undefined;
  }
  if (commit !== undefined && isHeldKey(commit)) {
    const branch = commit.slice("held:".length);
    const held = holds.find((entry) => entry.branch === branch);
    return held === undefined ? undefined : { kind: "held", commit: held.anchor, row: "held", branch };
  }
  if (commit !== undefined) {
    return { kind: "held", commit, row: "commit" };
  }
  if (activeReview.aggregate === true || activeReview.head === undefined) {
    return undefined;
  }
  return { kind: "held", row: "range", branch: activeReview.head };
};
