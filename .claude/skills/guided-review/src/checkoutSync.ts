/* notices the page's world changing under it: the served checkout switching
   branch - a `gh stack checkout` or `git switch` in a terminal, or an
   agent's - or the stack gaining, losing or reordering PRs. Which review
   saves to disk, which PR the stack bar marks checked out, and which PRs it
   has at all are settled as the page loads, so either means loading it
   again: straight away, or - while an editor holds edits not yet saved -
   once the reader says so. Where HEAD is, the bars mark live */

import { liveEditors } from "./liveEditors.ts";
import { server, shell } from "./payload.ts";
import { makeStore, toast } from "./stores.ts";

export type CheckoutNow = { branch: string | null; head: string | null; editableReviewId: string | null };

/** the branch and commit checked out, as the server last said - what the
    bars point at */
export const checkoutStore = makeStore<{ branch: string | null; head: string | null }>({
  branch: server?.checkedOut ?? null,
  head: null,
});

/** the change already told about, so a reader who isn't ready isn't asked
    again every poll */
let told = "";

/** the page is reloading for something it did itself - "switch to", say - so
    a poll seeing the same change must not reload it a second time */
let reloading = false;

export const reloadForOwnChange = (): void => {
  reloading = true;
  window.location.reload();
};

const loadedStack = shell.reviews.map((review) => review.key).join(" ");

export const followCheckout = (now: CheckoutNow | null | undefined, stack: string | null | undefined): void => {
  if (server === undefined || reloading) {
    return;
  }
  if (now !== null && now !== undefined) {
    const was = checkoutStore.get();
    if (was.branch !== now.branch || was.head !== now.head) {
      checkoutStore.set({ branch: now.branch, head: now.head });
    }
  }
  const switched =
    now !== null && now !== undefined && `${now.branch} ${now.editableReviewId}` !== `${server.checkedOut ?? null} ${server.editableReviewId ?? null}`;
  const restacked = stack !== null && stack !== undefined && stack !== loadedStack;
  if (!switched && !restacked) {
    return;
  }
  const what =
    switched ? `the checkout switched to ${now?.branch ?? "a detached HEAD"}`
    : "the stack changed - a PR joined it, left it or moved";
  const change = `${what} ${now?.editableReviewId ?? ""} ${stack ?? ""}`;
  if (change === told) {
    return;
  }
  told = change;
  if (![...liveEditors.values()].some((editor) => editor.isDirty())) {
    window.location.reload();
    return;
  }
  toast(`${what} - reload to see it (an editor has changes not saved yet)`, "warn", [
    { label: "Reload", onClick: () => window.location.reload() },
  ]);
};
