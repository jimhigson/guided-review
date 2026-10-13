import { alsoEditedIn, goToPlace, placeHref } from "../alsoEditedIn.ts";
import { type EditCommit, type ShellReview } from "../ReviewPayload.ts";

/** a link to the file in another PR or commit - plain text where the page
    doesn't carry that PR's review, since there is nothing to switch to */
const PlaceLink = ({
  review,
  commit,
  path,
  children,
}: {
  review: ShellReview;
  commit: EditCommit | undefined;
  path: string;
  children: string;
}) => {
  const title =
    commit === undefined ? `${review.label}: ${review.title}` : `${commit.short} ${commit.subject} — ${review.label}`;
  if (review.block === undefined) {
    return (
      <span class="also-place" title={`${title} — not reviewed in this page`}>
        {children}
      </span>
    );
  }
  return (
    <a
      class="also-place"
      href={placeHref(review, commit?.sha, path)}
      title={title}
      onClick={(event) => {
        // a plain click reads it here; a modified one is the browser's - a
        // new tab, say - and the url is the same place
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        goToPlace(review, commit?.sha, path);
      }}
    >
      {children}
    </a>
  );
};

/**
 * "also edited in PR 1/3 commit 3/5": the PRs and commits that change this
 * file too, which the page isn't showing right now - nothing at all when it
 * is showing every edit of it already
 */
export const AlsoEditedIn = ({ path }: { path: string }) => {
  const places = alsoEditedIn(path);
  if (places.length === 0) {
    return null;
  }
  return (
    <p class="also-edited">
      also edited in{" "}
      {places.map(({ review, pr, commits }, index) => (
        <>
          {index > 0 && "; "}
          {pr !== undefined && (
            <PlaceLink review={review} commit={undefined} path={path}>
              {pr}
            </PlaceLink>
          )}
          {pr !== undefined && commits.length > 0 && " "}
          {commits.length > 0 && (commits.length === 1 ? "commit " : "commits ")}
          {commits.map(({ commit, label }, commitIndex) => (
            <>
              {commitIndex > 0 && ", "}
              <PlaceLink review={review} commit={commit} path={path}>
                {label}
              </PlaceLink>
            </>
          ))}
        </>
      ))}
    </p>
  );
};
