/* the stack bar asks for a different review through here; main.tsx owns what
   switching actually involves (reload notes and ticks, remount the app) and
   registers itself at startup */

export type ReviewSwitcher = (
  /** the shell `key` of the review to make active */
  key: string,
) => void;

let switcher: ReviewSwitcher = () => {};

/** switching commit is the same kind of move as switching review: the files
    in view change, so the app remounts around them */
export type CommitSwitcher = (sha: string | undefined) => void;

let commitSwitcher: CommitSwitcher = () => {};

export const setCommitSwitcher = (next: CommitSwitcher): void => {
  commitSwitcher = next;
};

export const selectCommitAndRemount = (sha: string | undefined): void => {
  commitSwitcher(sha);
};

export const setReviewSwitcher = (next: ReviewSwitcher): void => {
  switcher = next;
};

export const switchReview = (key: string): void => {
  switcher(key);
};
