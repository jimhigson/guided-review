import { sortByDiffSize } from "../diffSizeOrder.ts";
import { files } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { ContentsTree, readFirst } from "./ContentsTree.tsx";

export type DiffSizeOrderProps = { state: ReadingState };

/** every file flattened and sorted by how much changed - biggest first,
    images at the top since they have no line count to sort by */
export const DiffSizeOrder = ({ state }: DiffSizeOrderProps) => (
  <ContentsTree
    state={state}
    nodes={readFirst(
      state,
      sortByDiffSize(files).map((file) => ({ kind: "file", id: `f:${file.id}`, file, showDir: true })),
    )}
    label="Changed files, biggest change first"
    as="ul"
    rootClass="tree tree-flat"
  />
);
