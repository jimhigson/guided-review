import { type ReviewFile } from "./ReviewPayload.ts";

/** the next file in `order` still to read after `from`, skipping any already
    ticked - wrapping round to one skipped earlier once there are none left
    after it. `from` itself is never the answer, ticked or not, so this can be
    asked straight after ticking it, before that tick has reached `ticked`.
    Undefined once everything else is read. */
export const nextUnread = (
  order: readonly ReviewFile[],
  ticked: ReadonlySet<string>,
  from: ReviewFile,
): ReviewFile | undefined => {
  const index = order.findIndex((candidate) => candidate.id === from.id);
  const unread = (candidate: ReviewFile) => !ticked.has(candidate.path);
  return order.slice(index + 1).find(unread) ?? order.slice(0, index).find(unread);
};
