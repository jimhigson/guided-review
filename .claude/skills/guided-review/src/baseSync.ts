/* keeps every file's before side on the review's current base. The server
   works out where the before side should be read from on each poll - where
   the head left its base branch, which a rebase or a merge of the base moves,
   or HEAD under a working tree, which a commit moves. When that moves under
   the page, every whole-range row's before side and line counts are read
   again from there, and the editors swap the new one in on their left. The
   right side, and any unsaved edit in it, is left alone.

   Moved code is found at build time against the old base, so it goes when
   the base does rather than marking lines that no longer line up. */

import { liveEditors } from "./liveEditors.ts";
import { activeReview, dropMoves, files, renamedFrom, reviewId, server, sides, stats } from "./payload.ts";
import { bumpPayloadVersion, toast } from "./stores.ts";
import { markChangedSinceRead } from "./ticks.ts";

export type ServerBase = { sha: string; reason?: string };

export type BeforeFile = { before: string; after: string; sha: string; added: number; removed: number };

/** the base each review's before sides were last read at, by review id */
const readAt = new Map<string, string>();
let inFlight = false;

export const followBase = async (base: ServerBase | undefined): Promise<void> => {
  const known = readAt.get(reviewId) ?? activeReview.baseSha;
  if (server === undefined || base === undefined || known === undefined || base.sha === known || inFlight) {
    return;
  }
  inFlight = true;
  try {
    // a commit's rows are history - only the review's whole-range rows follow
    const rows = files.filter((file) => file.commit === undefined && sides[file.path] !== undefined);
    const response = await fetch(`/before?review=${encodeURIComponent(reviewId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
      body: JSON.stringify({
        files: rows.map((file) => ({ path: file.path, from: renamedFrom?.[file.path] })),
      }),
    }).catch(() => undefined);
    if (response?.ok !== true) {
      return;
    }
    const fresh = (await response.json()) as { base: string; files: Record<string, BeforeFile> };

    dropMoves();
    for (const [path, file] of Object.entries(fresh.files)) {
      const side = sides[path];
      if (side === undefined) {
        continue;
      }
      if (side.before !== file.before) {
        markChangedSinceRead(path);
      }
      sides[path] = { ...side, before: file.before, after: file.after, sha: file.sha };
      stats[path] = [file.added, file.removed];
      liveEditors.get(path)?.applyBefore(file.before, [file.added, file.removed], file.after);
    }
    for (const editor of liveEditors.values()) {
      editor.refreshMoves();
    }
    readAt.set(reviewId, fresh.base);
    bumpPayloadVersion();
    toast(
      `the branch moved${base.reason === undefined || base.reason === "" ? "" : ` (${base.reason})`} — ` +
        `the before side now reads from ${fresh.base.slice(0, 9)}`,
    );
  } finally {
    inFlight = false;
  }
};
