import { type ComponentChildren } from "preact";
import { type CustomComponentsOption, SnarkdownInReact } from "snarkdown-in-react";

import { commitHere, goToPlace } from "../alsoEditedIn.ts";
import { activeReview, shell } from "../payload.ts";
import { isHeldKey, type ShellReview } from "../ReviewPayload.ts";

/** a link's url, where it is one the page will follow: the web, mail, a
    place in this page, or a path relative to it - never javascript: and
    the like, which an agent's text has no business running */
const safeHref = (href: string): string | undefined =>
  /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : undefined;

const safeSrc = (src: string): string | undefined => (/^(https?:|data:image\/)/i.test(src) ? src : undefined);

/** a link to a file of this page - `?review=…&commit=…&file=…`, as reply.ts
    writes for the files an agent edited - and where it goes */
const placeIn = (href: string): { url: string; review: ShellReview; commit: string | undefined; path: string } | undefined => {
  const url = new URL(href, window.location.href);
  const path = url.searchParams.get("file");
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || path === null) {
    return undefined;
  }
  const review = shell.reviews.find((candidate) => candidate.key === (url.searchParams.get("review") ?? activeReview.key));
  if (review?.block === undefined) {
    return undefined;
  }
  const commit = url.searchParams.get("commit") ?? undefined;
  // held edits since committed or discarded: the file is in the PR read whole
  const gone = commit !== undefined && isHeldKey(commit) && review.key === activeReview.key && !commitHere(commit);
  return { url: url.toString(), review, commit: gone ? undefined : commit, path };
};

const components: CustomComponentsOption = {
  // a link to a file of the review reads it here, in place, as the contents
  // does (a modified click is the browser's - a new tab, say). Any other link
  // opens in a tab of its own: following it here would leave the review, and
  // any edit not yet saved with it
  a: ({ href, children }: { href: string; children?: ComponentChildren }) => {
    const target = safeHref(href);
    const place = target === undefined ? undefined : placeIn(target);
    return target === undefined ?
        <span class="md-link-refused" title={`not a link the page will follow: ${href}`}>
          {children}
        </span>
      : place !== undefined ?
        <a
          class="md-file-link"
          href={place.url}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
              return;
            }
            event.preventDefault();
            goToPlace(place.review, place.commit, place.path);
          }}
        >
          {children}
        </a>
      : <a href={target} target="_blank" rel="noreferrer">
          {children}
        </a>;
  },
  img: ({ src, alt }: { src: string; alt: string }) => {
    const source = safeSrc(src);
    return source === undefined ? <span class="md-link-refused">{alt}</span> : <img src={source} alt={alt} />;
  },
};

/** markdown an agent wrote, rendered as elements - never as html, so its
    text can't inject any (snarkdown-in-react builds the tree itself) */
export const Markdown = ({ text }: { text: string }) => (
  <div class="md">
    <SnarkdownInReact markdown={text} customComponents={components} />
  </div>
);
