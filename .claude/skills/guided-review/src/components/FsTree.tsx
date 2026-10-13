import {
  hotkeysCoreFeature,
  type ItemInstance,
  selectionFeature,
  syncDataLoaderFeature,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { type VNode } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { buildFsTree, filesUnder, type FsTreeNode } from "../fsTree.ts";
import { notesStore } from "../notes.ts";
import { files, tickKeyOf } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { type ReviewFile } from "../ReviewPayload.ts";
import { payloadVersionStore, useStore } from "../stores.ts";
import { packageOf } from "../packages.ts";
import { packageTitle } from "./PathLabel.tsx";
import { TreeFileRow } from "./TreeFileRow.tsx";

const packageTitleOf = (dir: string): string => {
  const found = packageOf(dir);
  return found === undefined ? dir : packageTitle(found);
};

const rootId = "root";

/** what each item of the tree is: a directory (or package) node, or a file
    node, or the invisible root holding the top level */
type Item = { node?: FsTreeNode };

const idOf = (node: FsTreeNode): string =>
  node.type === "file" ? `f:${node.file.id}`
  : node.isPackage ? `p:${node.path}`
  : `d:${node.path}`;

const applyUpdate = <Value,>(updater: Value | ((old: Value) => Value), old: Value): Value =>
  typeof updater === "function" ? (updater as (old: Value) => Value)(old) : updater;

export type FsTreeProps = { state: ReadingState };

/**
 * the same changed files, nested by directory instead of reading order - for
 * browsing a large change by where it lives rather than the authored path
 * through it.
 *
 * It is a tree widget (Headless Tree): one tab stop, arrows to move,
 * left/right to fold and unfold, Home/End, click / ctrl-click / shift-click
 * (and shift-arrows, ctrl-A) to select, Enter to go to a file, and Space to
 * tick everything selected - or untick it, when it is all ticked already.
 * The library owns focus and selection; what each row looks like is ours.
 */
export const FsTree = ({ state }: FsTreeProps) => {
  const notes = useStore(notesStore);
  const payloadVersion = useStore(payloadVersionStore);
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set<string>());

  const tree = buildFsTree(files);
  const byId = new Map<string, FsTreeNode>();
  const index = (nodes: FsTreeNode[]): void => {
    for (const node of nodes) {
      byId.set(idOf(node), node);
      if (node.type === "dir") {
        index(node.children);
      }
    }
  };
  index(tree);

  const isTicked = (file: ReviewFile): boolean => state.ticked.has(tickKeyOf(file));
  // in the order the rows show them, so the keyboard walks what the eye
  // does: read files first (they gather as pills at the top of their
  // directory), then directories, then the files still to read
  const childIds = (nodes: FsTreeNode[]): string[] => [
    ...nodes.filter((node) => node.type === "file" && isTicked(node.file)).map(idOf),
    ...nodes.filter((node) => node.type === "dir").map(idOf),
    ...nodes.filter((node) => node.type === "file" && !isTicked(node.file)).map(idOf),
  ];
  const dirIds = [...byId.entries()].filter(([, node]) => node.type === "dir").map(([id]) => id);
  // the same array until a directory comes, goes, folds or unfolds: the tree
  // rebuilds itself whenever it is handed a different one, and the rebuild
  // renders this again
  const dirsKey = dirIds.join("\n");
  const expandedItems = useMemo(() => dirIds.filter((id) => !collapsedDirs.has(id)), [dirsKey, collapsedDirs]);

  /** the files a selection means. A directory counts as all of its files
      only when nothing inside it is selected too: a shift-range that runs
      through a directory's heading selects the heading on the way, and that
      mustn't pull in its files outside the range */
  const filesOf = (items: ItemInstance<Item>[]): ReviewFile[] => {
    const ids = items.map((item) => item.getId());
    return [
      ...new Set(
        items.flatMap((item) => {
          const { node } = item.getItemData();
          if (node === undefined) {
            return [];
          }
          const within = node.type === "dir" && ids.some((id) => id !== item.getId() && widget.getItemInstance(id).isDescendentOf(item.getId()));
          return within ? [] : filesUnder(node);
        }),
      ),
    ];
  };

  // ticking moves a file (read ones gather at the top of their directory),
  // and the browser drops the focus of an element it moves - so a tick made
  // from the tree puts the focus back once the rows have settled, or the
  // next key would go to the page instead
  const refocus = useRef(false);

  /** ticks them all, or - when they all are already - unticks them all */
  const tickAll = (targets: ReviewFile[], on = !targets.every(isTicked)): void => {
    refocus.current = true;
    for (const file of targets) {
      state.tickFile(file, on);
    }
  };

  /** ticking a selected item ticks the whole selection along with it */
  const tickItem = (item: ItemInstance<Item>, on: boolean, widget: TreeInstance<Item>): void => {
    const selected = widget.getSelectedItems();
    tickAll(filesOf(item.isSelected() && selected.length > 1 ? selected : [item]), on);
  };

  const widget = useTree<Item>({
    rootItemId: rootId,
    getItemName: (item) => {
      const { node } = item.getItemData();
      return node === undefined ? "" : node.type === "file" ? node.file.path : node.name;
    },
    isItemFolder: (item) => item.getItemData().node?.type !== "file",
    dataLoader: {
      getItem: (id) => (id === rootId ? {} : { node: byId.get(id) }),
      getChildren: (id) => {
        if (id === rootId) {
          return childIds(tree);
        }
        const node = byId.get(id);
        return node?.type === "dir" ? childIds(node.children) : [];
      },
    },
    // every directory starts open; what the reader folds stays folded, even
    // as files come and go
    state: { expandedItems },
    setExpandedItems: (updater) => {
      const open = new Set(applyUpdate(updater, expandedItems));
      setCollapsedDirs(new Set(dirIds.filter((id) => !open.has(id))));
    },
    onPrimaryAction: (item) => {
      const { node } = item.getItemData();
      if (node?.type === "file") {
        state.goTo(node.file);
      }
    },
    indent: 0,
    hotkeys: {
      customTickSelected: {
        hotkey: "Space",
        preventDefault: true,
        handler: (_event, current) => {
          const selected = current.getSelectedItems();
          tickAll(filesOf(selected.length > 0 ? selected : [current.getFocusedItem()]));
        },
      },
      customOpen: {
        hotkey: "Enter",
        preventDefault: true,
        handler: (_event, current) => {
          const item = current.getFocusedItem();
          if (!item.isFolder()) {
            item.primaryAction();
          } else if (item.isExpanded()) {
            item.collapse();
          } else {
            item.expand();
          }
        },
      },
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // the files, and the order ticking puts them in, are the tree's structure
  useEffect(() => {
    widget.rebuildTree();
    if (refocus.current) {
      refocus.current = false;
      widget.updateDomFocus();
    }
  }, [state.ticked, payloadVersion, files.length]);

  // the items in view, flat and in order, back into their nesting
  const items = widget.getItems();
  const childrenOf = new Map<string, ItemInstance<Item>[]>();
  for (const item of items) {
    const parent = item.getItemMeta().parentId;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), item]);
  }

  const renderItem = (item: ItemInstance<Item>): VNode | null => {
    const { node } = item.getItemData();
    if (node === undefined) {
      return null;
    }
    if (node.type === "file") {
      return (
        <TreeFileRow
          key={item.getKey()}
          file={node.file}
          state={state}
          notes={notes[node.file.path] ?? []}
          showDir={false}
          item={{
            props: item.getProps(),
            selected: item.isSelected(),
            onTick: (on) => tickItem(item, on, widget),
          }}
        />
      );
    }

    const descendants = filesUnder(node);
    const done = descendants.filter(isTicked).length;
    const open = item.isExpanded();
    return (
      <li class="fs-dir" key={item.getKey()}>
        <div {...item.getProps()} class={`fs-dir-head ${item.isSelected() ? "is-selected" : ""}`}>
          <input
            class="tick small"
            type="checkbox"
            checked={done === descendants.length}
            indeterminate={done > 0 && done < descendants.length}
            aria-label={`Tick every file in ${node.path}`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => tickItem(item, event.currentTarget.checked, widget)}
          />
          <span class="fs-dir-toggle">
            <span class="fs-dir-caret" aria-hidden="true">
              {open ? "" : ""}
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
          <span class="tree-count">
            {done}/{descendants.length}
          </span>
        </div>
        {open && (
          <ul class="fs-dir-children" role="group">
            {(childrenOf.get(item.getId()) ?? []).map(renderItem)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul {...widget.getContainerProps("Changed files, by directory")} class="tree fs-tree">
      {(childrenOf.get(rootId) ?? []).map(renderItem)}
    </ul>
  );
};
