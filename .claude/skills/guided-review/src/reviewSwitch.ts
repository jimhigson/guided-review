/* the stack bar asks for a different review through here; main.tsx owns what
   switching actually involves (reload notes and ticks, remount the app) and
   registers itself at startup */

export type ReviewSwitcher = (
  /** the shell `key` of the review to make active */
  key: string,
) => void;

let switcher: ReviewSwitcher = () => {};

export const setReviewSwitcher = (next: ReviewSwitcher): void => {
  switcher = next;
};

export const switchReview = (key: string): void => {
  switcher(key);
};
