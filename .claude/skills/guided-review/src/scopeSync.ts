/* keeps the file list in step with the review's scope. The reading order is
   authored, so it can't change under the reader - but a file that comes into
   scope after it was written (a new file, one that starts changing, one
   renamed since) gets a row in a last chapter of its own, with a live diff,
   rather than staying invisible until a rebuild. The server prints each one
   for the agent to place properly. A file the reading order lists that the
   change no longer covers drops out of view, and every listed file reads
   with the status it has now. */

import { isImagePath } from "./imagePaths.ts";
import {
  files,
  groups,
  leftOut,
  listedPaths,
  payload,
  reviewId,
  server,
  setLiveFiles,
  setScopeNow,
  sides,
  stats,
} from "./payload.ts";
import { bumpPayloadVersion, toast } from "./stores.ts";

export type ScopeFile = { path: string; status: string; from?: string };

/** a file as /before serves it: at the review's base, and as it is now */
type BeforeFile = { before: string; after: string; sha: string; added: number; removed: number };

const signature = (entries: Iterable<[string, string]>): string => JSON.stringify([...entries].sort());

let liveSignature = "[]";
let scopeSignature = "";
let inFlight = false;

/** a rebuild replaced the payload, live chapter and all - the next poll
    adds back whatever is still out of the reading order */
export const resetLiveFiles = (): void => {
  liveSignature = "[]";
  scopeSignature = "";
};

export const followScope = async (scope: ScopeFile[] | null | undefined): Promise<void> => {
  // a review authored commit by commit has rows that are history: there is no
  // one scope. (A served review's stops are in `commits` too - not authored)
  if (
    scope === null ||
    scope === undefined ||
    server === undefined ||
    (payload.commits ?? []).length > 0 ||
    inFlight
  ) {
    return;
  }
  const isLive = (file: (typeof files)[number]): boolean => groups[file.groupIndex]?.live === true;
  // the reading order's own files, whether or not they're in view - one the
  // change dropped is still listed, and comes back if the change does
  const listed = listedPaths();
  const skipped = new Set(leftOut ?? []);

  const inScope = new Map(scope.map((file) => [file.path, file.status]));
  const gone = new Set([...listed].filter((path) => !inScope.has(path)));
  const status = new Map([...listed].flatMap((path) => (inScope.has(path) ? [[path, inScope.get(path) ?? ""] as const] : [])));
  const nextScope = JSON.stringify([[...gone].sort(), [...status].sort()]);
  if (nextScope !== scopeSignature) {
    scopeSignature = nextScope;
    setScopeNow(gone, status);
    bumpPayloadVersion();
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
