/* what can become of held edits, and of the PRs above a PR that moved:
   each asks the server, then reloads - the branches have moved, and the
   page has been rebuilt to show them where they are now */

import { reloadForOwnChange } from "./checkoutSync.ts";
import { liveEditors } from "./liveEditors.ts";
import { reviewId, server } from "./payload.ts";
import { toast } from "./stores.ts";

/** whether to go ahead, when an editor holds something not saved yet */
const unsavedOk = (doing: string): boolean => {
  const dirty = [...liveEditors.values()].some((editor) => editor.isDirty());
  return !dirty || window.confirm(`An editor has changes not saved yet, lost on ${doing}. Go ahead?`);
};

const ask = async (path: string, body: unknown, doing: string): Promise<void> => {
  if (server === undefined || !unsavedOk(doing)) {
    return;
  }
  // replaying and rebuilding the page can take a few seconds
  toast(`${doing}…`);
  const response = await fetch(`${path}?review=${encodeURIComponent(reviewId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  const result =
    response === undefined ? { error: "the review server didn't answer" }
    : ((await response.json().catch(() => ({}))) as { error?: string; conflict?: string });
  if (response?.ok === true && result.conflict === undefined) {
    reloadForOwnChange();
    return;
  }
  toast(
    result.conflict !== undefined ?
      `${doing} hit a conflict, so nothing moved - the agent has been asked to resolve it (see its note)`
    : `couldn't finish ${doing}: ${result.error ?? "unknown error"}`,
    "warn",
  );
};

export const commitHeld = (branch: string, message: string): Promise<void> =>
  ask("/held/commit", { branch, mode: "new", message }, "committing the held edits");

export const amendHeld = (branch: string): Promise<void> =>
  ask("/held/commit", { branch, mode: "amend" }, "amending the held edits");

export const discardHeld = (branch: string): Promise<void> =>
  ask("/held/discard", { branch }, "discarding the held edits");

export const restack = (): Promise<void> => ask("/restack", {}, "rebasing upstack");
