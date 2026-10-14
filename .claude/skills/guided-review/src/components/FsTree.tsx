import { buildFsTree, filesUnder, type FsTreeNode } from "../fsTree.ts";
import { files } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { packageOf } from "../packages.ts";
import { type ContentsNode, ContentsTree, readFirst } from "./ContentsTree.tsx";
import { packageTitle } from "./PathLabel.tsx";

const packageTitleOf = (dir: string): string => {
  const found = packageOf(dir);
  return found === undefined ? dir : packageTitle(found);
};

export type FsTreeProps = { state: ReadingState };

/** the same changed files, nested by directory instead of reading order - for
    browsing a large change by where it lives rather than the authored path
    through it. Every directory starts open */
export const FsTree = ({ state }: FsTreeProps) => {
  const toNode = (node: FsTreeNode): ContentsNode =>
    node.type === "file" ?
      { kind: "file", id: `f:${node.file.id}`, file: node.file, showDir: false }
    : {
        kind: "folder",
        id: node.isPackage ? `p:${node.path}` : `d:${node.path}`,
        name: node.path,
        files: filesUnder(node),
        children: readFirst(state, node.children.map(toNode)),
        defaultOpen: true,
        layout: { kind: "nested", wrap: "fs-dir", head: "fs-dir-head", list: "fs-dir-children" },
        count: true,
        head: ({ open }) => (
          <span class="fs-dir-toggle">
            <span class="fs-dir-caret" aria-hidden="true">
              {open ? "\uf229" : "\uf231"}
            </span>
            {node.isPackage ?
              <span class="pkg-name" title={packageTitleOf(node.path)}>
                {node.name}
              </span>
            : <>
                <span class={`dir-icon ${open ? "is-open" : ""}`} aria-hidden="true" />
                <span class="fs-dir-name">{node.name}</span>
              </>
            }
          </span>
        ),
      };

  return (
    <ContentsTree
      state={state}
      nodes={readFirst(state, buildFsTree(files).map(toNode))}
      label="Changed files, by directory"
      as="ul"
      rootClass="tree fs-tree"
    />
  );
};
