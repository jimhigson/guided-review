/* notices the served checkout switching branch under an open page - a
   `gh stack checkout` or `git switch` in a terminal, or an agent's. Which
   review saves to disk, and which PR the stack bar marks checked out, are
   settled as the page loads, so a switch means loading it again: straight
   away, or - while an editor holds edits not yet saved - once the reader
   says so */

import { liveEditors } from "./liveEditors.ts";
import { server } from "./payload.ts";
import { toast } from "./stores.ts";

export type CheckoutNow = { branch: string | null; editableReviewId: string | null };

/** the switch already told about, so a reader who isn't ready isn't asked
    again every poll */
let told = "";

export const followCheckout = (now: CheckoutNow | null | undefined): void => {
  if (now === null || now === undefined || server === undefined) {
    return;
  }
  const loaded = `${server.checkedOut ?? null} ${server.editableReviewId ?? null}`;
  const current = `${now.branch} ${now.editableReviewId}`;
  if (current === loaded || current === told) {
    return;
  }
  told = current;
  const where = now.branch === null ? "a detached HEAD" : now.branch;
  if (![...liveEditors.values()].some((editor) => editor.isDirty())) {
    window.location.reload();
    return;
  }
  toast(`the checkout switched to ${where} - reload to edit from it (an editor has changes not saved yet)`, "warn", [
    { label: "Reload", onClick: () => window.location.reload() },
  ]);
};
