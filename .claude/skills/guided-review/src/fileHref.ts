/* the url of a file of the review being read - the page lands on the file a
   url names, the way a reload does, so this is a link that works in a new
   tab: the same review, the same commit, that file */

import { type ReviewFile } from "./ReviewPayload.ts";

export const fileHref = (file: ReviewFile): string => {
  const url = new URL(window.location.href);
  url.searchParams.set("file", file.path);
  return url.toString();
};
