/* The PR's comments, as the page has them: read from the server (which reads
   what prComments.ts wrote), and replied to through it. Unserved there are
   none - the page has no way to reach the forge on its own. */

import { type GithubReview } from "./githubTypes.ts";
import { reviewId, server } from "./payload.ts";
import { makeStore, toast } from "./stores.ts";

export const githubStore = makeStore<GithubReview | undefined>(undefined);

export const loadGithub = async (): Promise<void> => {
  if (server === undefined) {
    githubStore.set(undefined);
    return;
  }
  const response = await fetch(`/github?review=${encodeURIComponent(reviewId)}`).catch(
    () => undefined,
  );
  githubStore.set(
    response?.ok === true ? ((await response.json()) as GithubReview | null) ?? undefined : undefined,
  );
};

/**
 * says something back on the forge - in an inline thread when `replyTo` names
 * one, else in the PR's own conversation. It posts as whoever `gh` is signed
 * in as, so nothing here happens without a deliberate click.
 */
export const sayOnGithub = async (
  replyTo: number | undefined,
  text: string,
): Promise<boolean> => {
  const github = githubStore.get();
  if (server === undefined || github === undefined || text.trim() === "") {
    return false;
  }
  const response = await fetch(`/github-reply?review=${encodeURIComponent(reviewId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
    body: JSON.stringify({ pr: github.pr, replyTo, body: text }),
  }).catch(() => undefined);

  if (response?.ok !== true) {
    const said = (await response?.json().catch(() => undefined)) as { error?: string } | undefined;
    toast(`not posted to GitHub — ${said?.error ?? "the review server isn't answering"}`, "warn");
    return false;
  }
  // the server posts and re-reads in one go, so the thread has the reply in it
  githubStore.set((await response.json()) as GithubReview);
  toast(replyTo === undefined ? "commented on the PR" : "replied on GitHub", "done");
  return true;
};

/** how long ago, in the units a reviewer thinks in */
export const whenSaid = (createdAt: string): string => {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) {
    return "";
  }
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};
