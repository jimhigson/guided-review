/* What has been read. Served, it is the review's own file - so it survives a
   rebuild into another scratchpad or onto another port, two tabs on the same
   review agree, and the agent can see how far the reading has got. Without a
   server there is nowhere to write, and localStorage keyed by review id is the
   whole of it. */

import { reviewId, server } from "./payload.ts";
import { makeStore, toast } from "./stores.ts";

// keyed by review: without it every review served on this port - or carried
// in one stack page - would inherit another's ticks
const storageKey = (): string => `guidedReviewTicks:${reviewId}`;

const ticksUrl = (): string => `/ticks?review=${encodeURIComponent(reviewId)}`;

const localTicks = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey()) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

export const loadTicks = async (): Promise<Set<string>> => {
  if (server === undefined) {
    return localTicks();
  }
  const response = await fetch(ticksUrl()).catch(() => undefined);
  return new Set(
    response?.ok === true ? ((await response.json()) as { ticked: string[] }).ticked : [],
  );
};

/** files whose diff changed after they were ticked as read - an agent acting
    on a note, a rebase, another edit - by tick key. The app unticks them,
    since "read" stopped being true, and their rows say why until they are
    ticked again */
export const changedSinceRead = makeStore(new Set<string>());

export const markChangedSinceRead = (key: string): void => {
  // a file nobody has read yet changing is no news
  if (current.has(key) && !changedSinceRead.get().has(key)) {
    changedSinceRead.set(new Set([...changedSinceRead.get(), key]));
  }
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

export const ticksSignature = (ticked: Iterable<string>): string =>
  JSON.stringify([...ticked].sort());

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
  const ticked = queuedTicks ?? new Set<string>();
  queuedTicks = undefined;
  const response = await fetch(ticksUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server?.token ?? "" },
    body: JSON.stringify({ ticked: [...ticked] }),
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
      localStorage.setItem(storageKey(), JSON.stringify([...ticked]));
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
