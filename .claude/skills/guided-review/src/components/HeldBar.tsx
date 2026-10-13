import { useState } from "preact/hooks";

import { amendHeld, commitHeld, discardHeld } from "../heldActions.ts";
import { holdsHere } from "../payload.ts";
import { type HeldEdits } from "../ReviewPayload.ts";

const HeldRow = ({ held, many }: { held: HeldEdits; many: boolean }) => {
  const [message, setMessage] = useState("");
  const count = held.files.length;
  return (
    <div class="held-row">
      <span class="held-what">
        {count} file{count === 1 ? "" : "s"} edited, held after <code title={held.subject}>{held.short}</code>
        {many ? <> on <code>{held.branch}</code></> : null}
      </span>
      <input
        class="held-message"
        type="text"
        placeholder="commit message"
        aria-label={`Message for a new commit of the edits held on ${held.branch}`}
        value={message}
        onInput={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && message.trim() !== "") {
            void commitHeld(held.branch, message);
          }
        }}
      />
      <button
        type="button"
        class="held-action"
        disabled={message.trim() === ""}
        title={`a new commit after ${held.short}, with the PR's later commits replayed on top of it`}
        onClick={() => void commitHeld(held.branch, message)}
      >
        New commit
      </button>
      <button
        type="button"
        class="held-action"
        title={`fold the edits into ${held.short} "${held.subject}", the PR's later commits replayed on top of it`}
        onClick={() => void amendHeld(held.branch)}
      >
        Amend into {held.short}
      </button>
      <button
        type="button"
        class="held-action is-quiet"
        title="throw the held edits away (a backup ref keeps them)"
        onClick={() => void discardHeld(held.branch)}
      >
        Discard
      </button>
    </div>
  );
};

/**
 * under the commit bar, while any PR here has held edits: what is held and
 * where, and the ways to make it a commit - a new one after the commit the
 * edits were made against, or amended into that commit
 */
export const HeldBar = () => {
  const here = holdsHere();
  if (here.length === 0) {
    return null;
  }
  return (
    <div class="held-bar" aria-label="Held edits">
      {here.map((held) => (
        <HeldRow key={held.branch} held={held} many={here.length > 1} />
      ))}
    </div>
  );
};
