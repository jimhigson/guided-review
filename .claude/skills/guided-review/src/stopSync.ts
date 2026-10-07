/* keeps a served review's commit bar in step with the branch: its commits,
   what is staged, and what is only in the working tree, as the server lists
   them each poll. A stop's files are fetched when it is first read, and again
   whenever the stop being read changes under the reader - a `git add`, an
   edit - so staged and working read as they are now. */

import { liveEditors } from "./liveEditors.ts";
import { commitAskedFor, reviewId, selectedCommit, server, setStops, sides, stats, stops } from "./payload.ts";
import { type ReviewStop, sideKey } from "./ReviewPayload.ts";
import { selectCommitAndRemount } from "./reviewSwitch.ts";
import { bumpPayloadVersion } from "./stores.ts";
import { markChangedSinceRead } from "./ticks.ts";

type StopSide = { before: string; after: string; sha: string; added: number; removed: number };

const fileSignature = (file: ReviewStop["files"][number]): string =>
  `${file.status} ${file.from ?? ""} ${file.sha ?? ""}`;

let signature = "";
let inFlight = false;
let restoredFromUrl = false;

/** a rebuild replaced the payload, stop chapters and all */
export const resetStops = (): void => {
  signature = "";
};

/** fetches a stop's sides - every file of it, or just the ones named */
export const loadStopSides = async (key: string, only?: Set<string>): Promise<void> => {
  const stop = stops.find((candidate) => candidate.key === key);
  if (stop === undefined || server === undefined) {
    return;
  }
  const wanted = stop.files.filter((file) =>
    only === undefined ? sides[sideKey(file.path, key)] === undefined : only.has(file.path),
  );
  if (wanted.length === 0) {
    return;
  }
  const response = await fetch(`/stop-sides?review=${encodeURIComponent(reviewId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
    body: JSON.stringify({ stop: key, files: wanted.map((file) => ({ path: file.path, from: file.from })) }),
  }).catch(() => undefined);
  if (response?.ok !== true) {
    return;
  }
  const fresh = (await response.json()) as Record<string, StopSide>;
  for (const [path, side] of Object.entries(fresh)) {
    const fileKey = sideKey(path, key);
    const was = sides[fileKey];
    if (was !== undefined && (was.before !== side.before || was.after !== side.after)) {
      markChangedSinceRead(fileKey);
    }
    sides[fileKey] = { before: side.before, after: side.after, sha: side.sha };
    stats[fileKey] = [side.added, side.removed];
    liveEditors.get(fileKey)?.applyBefore(side.before, [side.added, side.removed], side.after);
  }
};

export const followStops = async (next: ReviewStop[] | null | undefined): Promise<void> => {
  if (next === null || next === undefined || server === undefined || inFlight) {
    return;
  }
  const nextSignature = JSON.stringify(next.map((stop) => [stop.key, stop.files.map((file) => [file.path, fileSignature(file)])]));
  if (nextSignature === signature) {
    return;
  }
  inFlight = true;
  try {
    const before = new Map(stops.map((stop) => [stop.key, new Map(stop.files.map((file) => [file.path, fileSignature(file)]))]));
    setStops(next);
    signature = nextSignature;

    // the stop being read: whatever in it changed, read again
    const reading = selectedCommit === undefined ? undefined : next.find((stop) => stop.key === selectedCommit);
    if (reading !== undefined) {
      const was = before.get(reading.key) ?? new Map<string, string>();
      const changed = new Set(
        reading.files.filter((file) => was.get(file.path) !== fileSignature(file)).map((file) => file.path),
      );
      await loadStopSides(reading.key);
      if (changed.size > 0) {
        await loadStopSides(reading.key, changed);
      }
    }
    bumpPayloadVersion();

    // a reload of a page that was reading a stop goes back to it, once the
    // server has said what the stops are
    if (!restoredFromUrl) {
      restoredFromUrl = true;
      const wanted = commitAskedFor;
      if (wanted !== undefined && wanted !== selectedCommit && next.some((stop) => stop.key === wanted)) {
        selectCommitAndRemount(wanted);
      }
    }
  } finally {
    inFlight = false;
  }
};
