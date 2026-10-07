/* keeps the file list in step with the review's scope. The reading order is
   authored, so it can't change under the reader - but a file that comes into
   scope after it was written (a new file, one that starts changing, one
   renamed since) gets a row in a last chapter of its own, with a live diff,
   rather than staying invisible until a rebuild. The server prints each one
   for the agent to place properly. A file the reading order lists that no
   longer differs keeps its place, marked, rather than shifting the order. */

import { type BeforeFile } from "./baseSync.ts";
import { isImagePath } from "./imagePaths.ts";
import { commits, files, groups, leftOut, reviewId, server, setLiveFiles, sides, stats } from "./payload.ts";
import { bumpPayloadVersion, makeStore, toast } from "./stores.ts";

export type ScopeFile = { path: string; status: string; from?: string };

/** listed files the change no longer covers, by path, with why: reverted
    or gone ("not in the change any more"), or "renamed to …" */
export const goneStore = makeStore(new Map<string, string>());

const signature = (entries: Iterable<[string, string]>): string => JSON.stringify([...entries].sort());

let liveSignature = "[]";
let inFlight = false;

export const followScope = async (scope: ScopeFile[] | null | undefined): Promise<void> => {
  // a commit-by-commit review's rows are history: there is no one scope
  if (scope === null || scope === undefined || server === undefined || commits.length > 0 || inFlight) {
    return;
  }
  const isLive = (file: (typeof files)[number]): boolean => groups[file.groupIndex]?.live === true;
  const listed = new Set(files.filter((file) => !isLive(file)).map((file) => file.path));
  const skipped = new Set(leftOut ?? []);

  const inScope = new Set(scope.map((file) => file.path));
  const renamedTo = new Map(
    scope.flatMap((file) => (file.from === undefined ? [] : [[file.from, file.path] as const])),
  );
  const gone = new Map(
    [...listed]
      .filter((path) => !inScope.has(path))
      .map((path) => [path, renamedTo.has(path) ? `renamed to ${renamedTo.get(path) ?? ""}` : "not in the change any more"]),
  );
  if (signature(gone) !== signature(goneStore.get())) {
    goneStore.set(gone);
  }

  // images have nothing the server can stream into a row yet
  const live = scope.filter(
    (file) => !listed.has(file.path) && !skipped.has(file.path) && !isImagePath(file.path),
  );
  const nextSignature = signature(live.map((file) => [file.path, `${file.status} ${file.from ?? ""}`]));
  if (nextSignature === liveSignature) {
    return;
  }

  inFlight = true;
  try {
    const before = new Set(files.filter(isLive).map((file) => file.path));
    const unread = live.filter((file) => sides[file.path] === undefined);
    if (unread.length > 0) {
      const response = await fetch(`/before?review=${encodeURIComponent(reviewId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
        body: JSON.stringify({ files: unread.map((file) => ({ path: file.path, from: file.from })) }),
      }).catch(() => undefined);
      if (response?.ok !== true) {
        return;
      }
      const fresh = (await response.json()) as { files: Record<string, BeforeFile> };
      for (const [path, file] of Object.entries(fresh.files)) {
        sides[path] = { before: file.before, after: file.after, sha: file.sha };
        stats[path] = [file.added, file.removed];
      }
    }
    setLiveFiles(live.filter((file) => sides[file.path] !== undefined));
    liveSignature = nextSignature;
    bumpPayloadVersion();

    const arrived = live.filter((file) => !before.has(file.path));
    if (arrived.length > 0) {
      toast(
        arrived.length === 1 ?
          `${arrived[0]?.path ?? ""} came into scope — it's in the last chapter until the reading order places it`
        : `${arrived.length} files came into scope — they're in the last chapter until the reading order places them`,
      );
    }
  } finally {
    inFlight = false;
  }
};
