/* keeps every file's payload snapshot (sides, stats) in step with disk -
   independent of whether a panel for it is open. A path with a live editor
   gets reconciled directly against it (loaded content swapped in, or a
   conflict raised); a path with no editor open has no model to reconcile
   into, so its baked-in snapshot is refreshed silently instead - opening it
   later then starts from disk, never from whatever the review was built
   from, and never hits a save conflict against a sha nobody asked about. */

import { notifyDiskConflict } from "./diskConflict.ts";
import { type FileFromDisk, liveEditors } from "./liveEditors.ts";
import { diskSyncPaths, reviewId, server, sides, stats } from "./payload.ts";
import { sideKey, uncommittedRef, workingRef } from "./ReviewPayload.ts";
import { bumpPayloadVersion, toastFileUpdated } from "./stores.ts";
import { markChangedSinceRead } from "./ticks.ts";

/** every path this review carries a text diff for that disk can still speak
    to - what the poll asks about. A commit's rows are history and are left
    out: the file on disk is not the file as that commit had it */
export const trackedPaths = (): string[] => diskSyncPaths();

export const fetchFileFromDisk = (path: string): Promise<FileFromDisk | undefined> => {
  if (server === undefined) {
    return Promise.resolve(undefined);
  }
  return fetch(`/file?review=${encodeURIComponent(reviewId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
    body: JSON.stringify({ path }),
  })
    .then((response) => response.json() as Promise<FileFromDisk>)
    .catch(() => undefined);
};

export const reconcileFiles = async (onDisk: Record<string, string>): Promise<void> => {
  for (const [path, diskSha] of Object.entries(onDisk)) {
    // the disk is the right side of a file's whole-range row, and of its row
    // under the uncommitted or working stop - each kept by its own key
    const keys = [path, sideKey(path, uncommittedRef), sideKey(path, workingRef)].filter(
      (key) => sides[key] !== undefined || liveEditors.has(key),
    );
    let fresh: Awaited<ReturnType<typeof fetchFileFromDisk>> | null = null;
    for (const key of keys) {
      const editor = liveEditors.get(key);
      const knownSha = editor?.sha() ?? sides[key]?.sha;
      if (knownSha === undefined || diskSha === knownSha) {
        continue;
      }
      fresh ??= (await fetchFileFromDisk(path)) ?? null;
      if (fresh === null) {
        break;
      }
      // its diff isn't what was read any more
      markChangedSinceRead(key);

      if (editor === undefined) {
        const side = sides[key];
        if (side !== undefined) {
          sides[key] = { ...side, after: fresh.after, sha: fresh.sha };
          stats[key] = [fresh.added, fresh.removed];
          // no editor to report the new counts, so the row has to be told
          bumpPayloadVersion();
        }
        continue;
      }
      if (editor.isDirty()) {
        notifyDiskConflict(path, fresh, editor);
        continue;
      }
      editor.applyFromDisk(fresh);
      toastFileUpdated(path);
    }
  }
};
