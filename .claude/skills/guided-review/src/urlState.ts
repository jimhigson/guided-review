/* keeps the browser url in sync with what's on screen - which review, which file
   - so a reload, or a copied link, lands back in the same place. Always
   replaceState, never pushState: activeId follows the scroll continuously,
   and pushing an entry per scroll tick would wreck the back button. */

const withUrlParam = (name: string, value: string): URL => {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  return url;
};

export const reviewKeyFromUrl = (): string | undefined =>
  new URLSearchParams(window.location.search).get("review") ?? undefined;

export const recordReviewInUrl = (key: string): void => {
  window.history.replaceState(window.history.state, "", withUrlParam("review", key));
};

/** which commit of the review is being read, when it has commits */
export const commitKeyFromUrl = (): string | undefined =>
  new URLSearchParams(window.location.search).get("commit") ?? undefined;

export const recordCommitInUrl = (sha: string | undefined): void => {
  const url = new URL(window.location.href);
  if (sha === undefined) {
    url.searchParams.delete("commit");
  } else {
    url.searchParams.set("commit", sha);
  }
  window.history.replaceState(window.history.state, "", url);
};

export const filePathFromUrl = (): string | undefined =>
  new URLSearchParams(window.location.search).get("file") ?? undefined;

export const recordFileInUrl = (path: string): void => {
  window.history.replaceState(window.history.state, "", withUrlParam("file", path));
};
