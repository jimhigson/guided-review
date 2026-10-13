import { useEffect, useRef } from "preact/hooks";

import { restack } from "../heldActions.ts";
import { staleStore } from "../heldSync.ts";
import { liveEditors } from "../liveEditors.ts";
import { activeReview, files, holds, server, shell, total } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { type ShellReview } from "../ReviewPayload.ts";
import { switchReview } from "../reviewSwitch.ts";
import { loadStackProgress, setSiblingTicked, stackProgressStore } from "../stackProgress.ts";
import { keepCurrentInView } from "./barScroll.ts";
import { toast, useStore } from "../stores.ts";

/** checks the PR's branch out in the served checkout (`gh stack checkout`),
    then reloads - which review the checkout can edit is settled as the page
    loads, and that is what just changed */
const switchCheckoutTo = async (branch: string): Promise<void> => {
  if (server === undefined) {
    return;
  }
  const dirty = [...liveEditors.values()].some((editor) => editor.isDirty());
  if (dirty && !window.confirm(`Unsaved edits are lost on switching the checkout to ${branch}. Switch anyway?`)) {
    return;
  }
  const response = await fetch("/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
    body: JSON.stringify({ branch }),
  }).catch(() => undefined);
  if (response?.ok === true) {
    window.location.reload();
    return;
  }
  const said = response === undefined ? "the review server didn't answer" : ((await response.json()) as { error?: string }).error;
  toast(`couldn't switch to ${branch}: ${said ?? "unknown error"}`, "warn");
};

/** beside each PR of a served stack: whether its branch is the checkout, or
    a way to make it so */
const CheckoutControl = ({ branch }: { branch: string | undefined }) => {
  if (server === undefined || branch === undefined) {
    return null;
  }
  return server.checkedOut === branch ?
      <span class="stack-checked-out" title={`${branch} is checked out here`}>
        checked out
      </span>
    : <button
        type="button"
        class="stack-switch"
        title={`gh stack checkout ${branch}`}
        onClick={() => void switchCheckoutTo(branch)}
      >
        switch to
      </button>;
};

export type StackBarProps = { state: ReadingState };

/**
 * The PR-stack strip along the top: every PR of the stack in order, trunk end
 * first, with the active review highlighted, and - where the build made one -
 * an "all" switch at the end for reading every layer at once. A sibling whose review the page
 * carries is a button that switches to it in place; one without a review is
 * greyed - marked "awaiting review" when a contribution has been requested -
 * and links to the forge in a new tab. Each carried review gets a checkbox
 * showing whether every one of its files has been ticked - live for the
 * active review, fetched once for the others - and ticking it there ticks
 * every file of that review at once.
 */
export const StackBar = ({ state }: StackBarProps) => {
  const progress = useStore(stackProgressStore);
  const stale = useStore(staleStore);
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    loadStackProgress();
  }, []);

  // a long stack scrolls; the one being read should be on screen when it does
  useEffect(() => keepCurrentInView(bar.current), []);

  if (shell.reviews.length < 2) {
    return null;
  }
  const active = activeReview;
  const layers = shell.reviews.filter((review) => review.aggregate !== true);
  const everyLayer = shell.reviews.find((review) => review.aggregate === true);
  const readingEveryLayer = active.aggregate === true;

  const readCheckbox = (review: ShellReview) => {
    const isActiveReview = review.key === active.key;
    const [done, reviewTotal] =
      isActiveReview ? [state.ticked.size, total] : (
        [progress[review.key]?.ticked ?? 0, progress[review.key]?.total ?? 0]
      );
    const onToggle = (on: boolean) => {
      if (isActiveReview) {
        for (const file of files) {
          state.tickFile(file, on);
        }
        return;
      }
      if (review.block === undefined) {
        return;
      }
      setSiblingTicked({ ...review, block: review.block }, on);
    };
    return (
      // the checkbox alone is much shorter than the pill around it - wrapped
      // in a label stretched to its full height, a click anywhere in that
      // column reaches the checkbox, not just its own small square
      <label class="stack-tick-hit">
        <input
          class="tick small"
          type="checkbox"
          checked={reviewTotal > 0 && done === reviewTotal}
          indeterminate={done > 0 && done < reviewTotal}
          aria-label={`Tick every file in ${review.title}`}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
      </label>
    );
  };

  return (
    <nav class="stack-bar bar-scrolls" aria-label="PR stack" ref={bar}>
      <span class="bar-pinned">
      <span class="stack-label">stack</span>
      {everyLayer !== undefined && (
        // not a step of the chain - a way of reading the whole chain at once,
        // so it sits apart from the arrows rather than in them. A plain
        // button, not a checkbox: the checkboxes along this bar mean "every
        // file of this one is read", and this means "show me all of them"
        <button
          type="button"
          class={`stack-all ${readingEveryLayer ? "is-current" : ""}`}
          aria-pressed={readingEveryLayer}
          title={`${everyLayer.title} - every file once, with what each PR said about it`}
          disabled={readingEveryLayer}
          onClick={() => switchReview(everyLayer.key)}
        >
          all
        </button>
      )}
      </span>
      {layers.map((review, index) => (
        <span class="stack-step" key={review.key}>
          {index > 0 && <span class="stack-arrow">→</span>}
          {review.key === active.key ?
            <span class="stack-pr-pill is-current">
              {readCheckbox(review)}
              <span class="stack-pr in-pill is-current" title={review.title} aria-current="page">
                <span class="stack-number">{review.label}</span>
                <span class="stack-title">{review.title}</span>
              </span>
            </span>
          : review.block !== undefined ?
            <span class="stack-pr-pill">
              {readCheckbox(review)}
              <button
                type="button"
                class="stack-pr in-pill"
                title={review.title}
                onClick={() => switchReview(review.key)}
              >
                <span class="stack-number">{review.label}</span>
                <span class="stack-title">{review.title}</span>
              </button>
            </span>
          : // a layer of a local stack has no forge page to link to, so it
            // stands as plain text rather than a link back to this page
            (() => {
              const inside = (
                <>
                  <span class="stack-number">{review.label}</span>
                  <span class="stack-title">{review.title}</span>
                  {review.awaitingContribution === true && (
                    <span class="stack-awaiting">awaiting review</span>
                  )}
                  {review.url !== "" && <span class="stack-forge">↗</span>}
                </>
              );
              const describe = `${review.title} — ${
                review.awaitingContribution === true ?
                  "review requested from its agent, not yet contributed"
                : "no review in this page"
              }`;
              return review.url === "" ?
                  <span class="stack-pr is-unreviewed" title={describe}>
                    {inside}
                  </span>
                : <a
                    class="stack-pr is-unreviewed"
                    href={review.url}
                    target="_blank"
                    rel="noreferrer"
                    title={describe}
                  >
                    {inside}
                  </a>;
            })()
          }
          {holds.some((held) => held.branch === review.head) && (
            <span class="stack-held" title={`${review.head ?? ""} has edits held, not committed`}>
              held
            </span>
          )}
          <CheckoutControl branch={review.head} />
        </span>
      ))}
      {stale.length > 0 && (
        <button
          type="button"
          class="stack-restack"
          title={`replay ${stale.join(", ")} onto the PR below, which has moved - all of them, or none if any conflicts`}
          onClick={() => void restack()}
        >
          Rebase {stale.length} upstack
        </button>
      )}
    </nav>
  );
};
