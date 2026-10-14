import { fileHref } from "../fileHref.ts";
import { runsByPath } from "../pathRuns.ts";
import { filesInGroup, groups, tickKeyOf } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { type ContentsNode, ContentsTree } from "./ContentsTree.tsx";
import { TruncatedPathLabel } from "./PathLabel.tsx";

export type GuidedOrderProps = { state: ReadingState };

/**
 * the reading order authored into the review: every chapter in order, each
 * with its files in the order to read them - the default contents view.
 *
 * A chapter starts open, and closes once every file in it is ticked - until
 * the reader folds or unfolds it, which then sticks. Clicking a chapter goes
 * to its first file. Inside one, a run of files in the same directory sits
 * under a heading naming it; read files gather above the headings as pills,
 * and a heading left with nothing unread goes
 */
export const GuidedOrder = ({ state }: GuidedOrderProps) => {
  const isTicked = (file: Parameters<typeof tickKeyOf>[0]): boolean => state.ticked.has(tickKeyOf(file));

  const nodes: ContentsNode[] = groups.map((group, index) => {
    const files = filesInGroup(index);
    const fileNode = (file: (typeof files)[number]): ContentsNode => ({ kind: "file", id: `f:${file.id}`, file, showDir: false });
    const runs = runsByPath(files).flatMap((run, runIndex): ContentsNode[] => {
      const unread = run.files.filter((file) => !isTicked(file));
      if (run.path === "") {
        return unread.map(fileNode);
      }
      return unread.length === 0 ?
          []
        : [
            {
              kind: "folder",
              id: `r:${index}:${runIndex}`,
              name: run.path,
              files: run.files,
              children: unread.map(fileNode),
              defaultOpen: true,
              layout: { kind: "inline", head: "tree-path-heading" },
              count: false,
              head: () => (
                <>
                  <span class="dir-icon is-open" aria-hidden="true" />
                  <TruncatedPathLabel class="tree-path-label" path={run.path} suffix="/" />
                </>
              ),
            },
          ];
    });
    return {
      kind: "folder",
      id: `g:${index}`,
      name: group.title,
      files,
      children: [...files.filter(isTicked).map(fileNode), ...runs],
      defaultOpen: !files.every(isTicked),
      layout: { kind: "nested", wrap: "tree-group", head: "tree-group-head", list: "tree-files" },
      count: true,
      head: () => (
        // a link to the chapter's first file, for a new tab; a plain click is
        // the tree's, and goes there in place
        <a
          class="tree-group-title"
          href={files[0] === undefined ? undefined : fileHref(files[0])}
          title={group.title}
          tabIndex={-1}
          onClick={(event) => event.preventDefault()}
        >
          Chapter {index + 1}: {group.title}
        </a>
      ),
      tail: ({ open, toggle }) => (
        <button
          type="button"
          class="caret"
          tabIndex={-1}
          aria-expanded={open}
          aria-label={open ? "Collapse this chapter" : "Expand this chapter"}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {open ? "\uf229" : "\uf231"}
        </button>
      ),
      open: () => state.goTo(files[0]),
      // ticking a whole chapter folds it in the reading order too
      tick: (on) => state.tickGroup(index, on),
    };
  });

  return <ContentsTree state={state} nodes={nodes} label="Contents, in reading order" as="ol" rootClass="tree" />;
};
