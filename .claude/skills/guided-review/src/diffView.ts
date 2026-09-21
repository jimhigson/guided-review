/* inline, side-by-side or 3-way, for every diff on the page at once.
   Remembered per reader rather than per review - which way you read a diff is
   a habit, not something to re-choose for each change. Conflict reviews keep a
   choice of their own, defaulting to 3-way: it is the reason to build one, and
   choosing 2-way on one shouldn't turn every ordinary review's choice with it. */

import { conflict } from "./payload.ts";
import { makeStore } from "./stores.ts";

export type DiffView = "inline" | "sideBySide" | "threeWay";

const storageKey = "guidedReviewDiffView";
const conflictStorageKey = "guidedReviewConflictDiffView";

/** whether the 3-way view can be offered - only a conflict review has a third
    side to show */
export const threeWayAvailable = (): boolean => conflict !== undefined;

const remembered = (): DiffView => {
  const fallback: DiffView = threeWayAvailable() ? "threeWay" : "inline";
  try {
    const stored = localStorage.getItem(threeWayAvailable() ? conflictStorageKey : storageKey);
    return (
        stored === "inline" ||
          stored === "sideBySide" ||
          (stored === "threeWay" && threeWayAvailable())
      ) ?
        stored
      : fallback;
  } catch {
    return fallback;
  }
};

export const diffViewStore = makeStore<DiffView>(remembered());

export const setDiffView = (view: DiffView): void => {
  try {
    localStorage.setItem(threeWayAvailable() ? conflictStorageKey : storageKey, view);
  } catch {
    /* storage unavailable - the choice just won't outlive the page */
  }
  diffViewStore.set(view);
};

export const showsBothSides = (view: DiffView): boolean => view !== "inline";
