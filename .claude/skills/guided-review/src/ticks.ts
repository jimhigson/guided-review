/* What has been read. Served, it is the review's own file - so it survives a
   rebuild into another scratchpad or onto another port, two tabs on the same
   review agree, and the agent can see how far the reading has got. Without a
   server there is nowhere to write, and localStorage keyed by review id is the
   whole of it. */

import { liveEditors } from "./liveEditors.ts";
import { meta, payload, reviewId, server, sides } from "./payload.ts";
import { makeStore, toast } from "./stores.ts";

// keyed by review: without it every review served on this port - or carried
// in one stack page - would inherit another's ticks
const storageKey = (): string => `guidedReviewTicks:${reviewId}`;

const ticksUrl = (): string => `/ticks?review=${encodeURIComponent(reviewId)}`;

/* A tick is of a diff as it was when it was ticked. ticks.json holds
   {key, sha} for each, the sha an id of that diff - so "changed since read"
   means the diff really is different now, not that it differs from some
   snapshot the reader never saw (a build of the committed head, with the
   reader's uncommitted work on top of it on disk). A plain key, as older
   ticks.json files hold, takes the diff as it is the first time it is
   looked at. */
export type TickEntry = string | { key: string; sha: string };

/** what each ticked key was of, when ticked */
const readAs = new Map<string, string>();

/** a quick, stable hash of a side's text - only ever compared with itself */
const hashOf = (text: string): string => {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
};

/** the diff a row shows now: its before side, and its after side as the
    disk (or its open editor) has it */
const diffIdOf = (key: string): string | undefined => {
  const side = sides[key];
  if (side === undefined) {
    return undefined;
  }
  return `${hashOf(side.before)}:${liveEditors.get(key)?.sha() ?? side.sha}`;
};

/** ticks as stored: keys, taking each one's read-as id where it has one */
export const takeEntries = (entries: TickEntry[]): Set<string> => {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") {
      keys.add(entry);
    } else {
      keys.add(entry.key);
      readAs.set(entry.key, entry.sha);
    }
  }
  return keys;
};

/** ticks to store: each key with what it was of - a new tick is of the diff
    as it is now, being ticked */
const entriesOf = (ticked: Set<string>): TickEntry[] => {
  for (const key of [...readAs.keys()]) {
    if (!ticked.has(key)) readAs.delete(key);
  }
  return [...ticked].map((key) => {
    const known = readAs.get(key) ?? diffIdOf(key);
    if (known === undefined) return key;
    readAs.set(key, known);
    return { key, sha: known };
  });
};

const localTicks = (): { ticked: Set<string>; fresh: boolean } => {
  try {
    const stored = localStorage.getItem(storageKey());
    return { ticked: takeEntries(JSON.parse(stored ?? "[]") as TickEntry[]), fresh: stored === null };
  } catch {
    return { ticked: new Set(), fresh: false };
  }
};

/** a review nothing has been ticked in yet starts with its mechanical files
    ticked, when the reader agreed to that - written straight back, so it is
    the review's own state from then on rather than a default reapplied */
const startingTicks = ({ ticked, fresh }: { ticked: Set<string>; fresh: boolean }): Set<string> => {
  if (!fresh || meta.preTickMechanical !== true) {
    return ticked;
  }
  const mechanical = new Set(Object.keys(payload.mechanical ?? {}));
  if (mechanical.size > 0) {
    saveTicks(mechanical);
  }
  return mechanical;
};

export const loadTicks = async (): Promise<Set<string>> => {
  if (server === undefined) {
    return startingTicks(localTicks());
  }
  const response = await fetch(ticksUrl()).catch(() => undefined);
  const read =
    response?.ok === true ?
      ((await response.json()) as { ticked: TickEntry[]; fresh?: boolean })
    : { ticked: [], fresh: false };
  return startingTicks({ ticked: takeEntries(read.ticked), fresh: read.fresh === true });
};

/** files whose diff changed after they were ticked as read - an agent acting
    on a note, a rebase, another edit - by tick key. The app unticks them,
    since "read" stopped being true, and their rows say why until they are
    ticked again */
export const changedSinceRead = makeStore(new Set<string>());

/** asked once a row's sides are up to date with whatever just moved: marks
    it only when it was ticked and its diff isn't the one ticked */
export const markChangedSinceRead = (key: string): void => {
  // a file nobody has read yet changing is no news
  if (!current.has(key) || changedSinceRead.get().has(key)) {
    return;
  }
  const now = diffIdOf(key);
  const was = readAs.get(key);
  if (now === undefined || now === was) {
    return;
  }
  if (was === undefined) {
    // ticked before ticks said what of: take it as of what is here now
    readAs.set(key, now);
    return;
  }
  changedSinceRead.set(new Set([...changedSinceRead.get(), key]));
};

export const clearChangedSinceRead = (key: string): void => {
  if (changedSinceRead.get().has(key)) {
    changedSinceRead.set(new Set([...changedSinceRead.get()].filter((each) => each !== key)));
  }
};

/** ticks the page has taken from the file, so the poll can tell a change made
    somewhere else from the echo of one made here */
export const adoptTicks = makeStore(new Set<string>());

/** what is ticked right now, for anything outside the app that has to remount
    it - switching commit keeps the same review, and so the same ticks */
let current = new Set<string>();

export const setCurrentTicks = (ticked: Set<string>): void => {
  current = ticked;
};

export const currentTicks = (): Set<string> => current;

export const ticksSignature = (ticked: Iterable<TickEntry>): string =>
  JSON.stringify(
    [...ticked].map((entry) => (typeof entry === "string" ? entry : `${entry.key}\u0000${entry.sha}`)).sort(),
  );

let lastFromServer = "[]";

export const setLastFromServer = (signature: string): void => {
  lastFromServer = signature;
};

export const getLastFromServer = (): string => lastFromServer;

/** while a write is in flight the page is ahead of the file, so the poll must
    not hand it back what it is in the middle of replacing */
let ticksInFlight = 0;
let queuedTicks: Set<string> | undefined;

export const ticksAreInFlight = (): boolean => ticksInFlight > 0;

const postTicks = async (): Promise<void> => {
  const ticked = entriesOf(queuedTicks ?? new Set<string>());
  queuedTicks = undefined;
  const response = await fetch(ticksUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server?.token ?? "" },
    body: JSON.stringify({ ticked }),
  }).catch(() => undefined);
  ticksInFlight -= 1;
  if (response?.ok !== true) {
    toast("ticks not saved — the review server isn't answering", "warn");
    return;
  }
  lastFromServer = ticksSignature(ticked);
};

export const saveTicks = (ticked: Set<string>): void => {
  current = ticked;
  if (server === undefined) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(entriesOf(ticked)));
    } catch {
      /* storage unavailable - ticks just won't persist */
    }
    return;
  }
  // ticking a whole group is one state change but many clicks are not, so the
  // writes are coalesced rather than one per checkbox
  const first = queuedTicks === undefined;
  queuedTicks = ticked;
  if (first) {
    ticksInFlight += 1;
    setTimeout(postTicks, 250);
  }
};

export const withMembership = <T,>(set: Set<T>, key: T, member: boolean): Set<T> => {
  const next = new Set(set);
  if (member) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
};
