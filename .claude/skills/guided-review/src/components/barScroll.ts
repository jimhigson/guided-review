/* A bar of PRs or commits can be longer than the window. It scrolls, with its
   label and "all" pinned to the left so the way back to the whole is never
   scrolled away - and whichever one is being read brought into view, since a
   bar that opens showing the wrong end of a long chain is no use. */

export const keepCurrentInView = (bar: HTMLElement | null): void => {
  const current = bar?.querySelector(".is-current");
  current?.scrollIntoView({ inline: "center", block: "nearest" });
};
