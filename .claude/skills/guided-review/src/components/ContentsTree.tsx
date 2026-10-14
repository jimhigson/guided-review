import {
  hotkeysCoreFeature,
  type ItemInstance,
  selectionFeature,
  syncDataLoaderFeature,
  type TreeInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { type ComponentChildren, type VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { notesStore } from "../notes.ts";
import { files as reviewFiles, tickKeyOf } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { type ReviewFile } from "../ReviewPayload.ts";
import { payloadVersionStore, useStore } from "../stores.ts";
import { TreeFileRow } from "./TreeFileRow.tsx";

/** a folder's heading: its own markup, inside the element the tree item is */
export type FolderHead = {
  open: boolean;
  toggle: () => void;
  done: number;
  total: number;
};

/** one entry of a contents view - a file, or something holding files */
export type ContentsNode =
  | { kind: "file"; id: string; file: ReviewFile; showDir: boolean }
  | {
      kind: "folder";
      id: string;
      /** what it is called, for the tree's accessible name */
      name: string;
      /** every file under it - what ticking it ticks */
      files: ReviewFile[];
      /** what it shows, in the order shown */
      children: ContentsNode[];
      defaultOpen: boolean;
      /** nested: the heading, then its children in a list of their own inside
          one wrapper; inline: the heading, then its children as siblings
          after it, in the same list */
      layout: { kind: "nested"; wrap: string; head: string; list: string } | { kind: "inline"; head: string };
      /** the heading's own content, between its tick box and its count */
      head: (folder: FolderHead) => ComponentChildren;
      /** after the count - a chapter's caret */
      tail?: (folder: FolderHead) => ComponentChildren;
      /** show "done/total" */
      count: boolean;
      /** what a plain click and Enter do, instead of folding it: a chapter
          goes to its first file. Arrows still fold */
      open?: () => void;
      /** ticking it on its own, rather than as part of a selection */
      tick?: (on: boolean) => void;
    };

type FolderNode = Extract<ContentsNode, { kind: "folder" }>;

/** in the tree's data: a node, or nothing for the invisible root */
type Item = { node?: ContentsNode };

const rootId = "root";

const applyUpdate = <Value,>(updater: Value | ((old: Value) => Value), old: Value): Value =>
  typeof updater === "function" ? (updater as (old: Value) => Value)(old) : updater;

export type ContentsTreeProps = {
  state: ReadingState;
  /** the top level, in the order shown */
  nodes: ContentsNode[];
  /** the tree's accessible name */
  label: string;
  /** the container: its element and class */
  as: "ul" | "ol";
  rootClass: string;
};

/**
 * a contents view as a tree widget (Headless Tree): one tab stop, arrows to
 * move, left/right to fold and unfold, Home/End, click / ctrl-click /
 * shift-click (and shift-arrows, ctrl-A) to select, Enter to go to a file
 * (or a chapter), and Space to tick everything selected - or untick it, when
 * it is all ticked already. Ticking a selected item's box ticks the whole
 * selection. The library owns focus and selection; the rows are the page's
 * own, and each view says what its folders look like.
 *
 * A view hands its nodes over in the order it shows them - read files first,
 * gathered as pills - so the keyboard walks what the eye does.
 */
export const ContentsTree = ({ state, nodes, label, as: Container, rootClass }: ContentsTreeProps) => {
  const notes = useStore(notesStore);
  const payloadVersion = useStore(payloadVersionStore);
  // what the reader folded or unfolded, over each folder's own default
  const [overrides, setOverrides] = useState(() => new Map<string, boolean>());

  const byId = new Map<string, ContentsNode>();
  const index = (list: ContentsNode[]): void => {
    for (const node of list) {
      byId.set(node.id, node);
      if (node.kind === "folder") {
        index(node.children);
      }
    }
  };
  index(nodes);
  const folders = [...byId.values()].filter((node): node is FolderNode => node.kind === "folder");
  const isOpen = (folder: FolderNode): boolean => overrides.get(folder.id) ?? folder.defaultOpen;

  // the same array until a folder comes, goes, opens or closes: the tree
  // rebuilds itself whenever it is handed a different one, and the rebuild
  // renders this again
  const expandedRef = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const openIds = folders.filter(isOpen).map((folder) => folder.id);
  if (openIds.join("\n") !== expandedRef.current.key) {
    expandedRef.current = { key: openIds.join("\n"), ids: openIds };
  }
  const expandedItems = expandedRef.current.ids;

  const isTicked = (file: ReviewFile): boolean => state.ticked.has(tickKeyOf(file));
  const filesOfNode = (node: ContentsNode): ReviewFile[] => (node.kind === "file" ? [node.file] : node.files);

  /** the files a selection means. A folder counts as all of its files only
      when nothing it stands for is selected too: a shift-range that runs
      through a folder's heading selects the heading on the way, and that
      mustn't pull in its files outside the range. Judged by its files, not
      by where they sit now - a read file moves up out from under its heading,
      but is still one of the heading's */
  const filesOf = (items: ItemInstance<Item>[]): ReviewFile[] => {
    const nodesSelected = items.flatMap((item) => item.getItemData().node ?? []);
    const filesSelected = new Set(nodesSelected.flatMap((node) => (node.kind === "file" ? [node.file.id] : [])));
    const partOf = (folder: FolderNode): boolean =>
      folder.files.some((file) => filesSelected.has(file.id)) ||
      nodesSelected.some(
        (other) =>
          other !== folder &&
          other.kind === "folder" &&
          other.files.length < folder.files.length &&
          other.files.every((file) => folder.files.includes(file)),
      );
    return [
      ...new Set(
        nodesSelected.flatMap((node) => (node.kind === "folder" && partOf(node) ? [] : filesOfNode(node))),
      ),
    ];
  };

  // ticking moves a file (read ones gather at the top of their folder), and
  // the browser drops the focus of an element it moves - so a tick made from
  // the tree puts the focus back once the rows have settled, or the next key
  // would go to the page instead
  const refocus = useRef(false);

  /** ticks them all, or - when they all are already - unticks them all */
  const tickAll = (targets: ReviewFile[], on = !targets.every(isTicked)): void => {
    refocus.current = true;
    for (const file of targets) {
      state.tickFile(file, on);
    }
  };

  /** ticking a selected item ticks the whole selection along with it; one
      on its own ticks the way its view says */
  const tickItem = (item: ItemInstance<Item>, on: boolean, tree: TreeInstance<Item>): void => {
    const selected = tree.getSelectedItems();
    if (item.isSelected() && selected.length > 1) {
      tickAll(filesOf(selected), on);
      return;
    }
    const { node } = item.getItemData();
    if (node?.kind === "folder" && node.tick !== undefined) {
      refocus.current = true;
      node.tick(on);
      return;
    }
    tickAll(filesOf([item]), on);
  };

  const widget = useTree<Item>({
    rootItemId: rootId,
    getItemName: (item) => {
      const { node } = item.getItemData();
      return node === undefined ? "" : node.kind === "file" ? node.file.path : node.name;
    },
    isItemFolder: (item) => item.getItemData().node?.kind === "folder",
    dataLoader: {
      getItem: (id) => (id === rootId ? {} : { node: byId.get(id) }),
      getChildren: (id) => {
        const list = id === rootId ? nodes : (() => {
          const node = byId.get(id);
          return node?.kind === "folder" ? node.children : [];
        })();
        return list.map((node) => node.id);
      },
    },
    state: { expandedItems },
    setExpandedItems: (updater) => {
      const open = new Set(applyUpdate(updater, expandedItems));
      setOverrides((previous) => {
        const next = new Map(previous);
        for (const folder of folders) {
          if (open.has(folder.id) !== isOpen(folder)) {
            next.set(folder.id, open.has(folder.id));
          }
        }
        return next;
      });
    },
    onPrimaryAction: (item) => {
      const { node } = item.getItemData();
      if (node?.kind === "file") {
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
          const { node } = item.getItemData();
          if (node?.kind !== "folder") {
            item.primaryAction();
          } else if (node.open !== undefined) {
            node.open();
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
  }, [state.ticked, payloadVersion, reviewFiles.length]);

  // the items in view, flat and in order, back into their nesting
  const childrenOf = new Map<string, ItemInstance<Item>[]>();
  for (const item of widget.getItems()) {
    const parent = item.getItemMeta().parentId;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), item]);
  }

  /** a folder whose plain click goes somewhere selects as a click would,
      without folding */
  const propsOf = (item: ItemInstance<Item>, node: FolderNode): Record<string, unknown> => {
    const props = item.getProps();
    if (node.open === undefined) {
      return props;
    }
    return {
      ...props,
      onClick: (event: MouseEvent) => {
        item.setFocused();
        const modified = event.ctrlKey || event.metaKey;
        if (event.shiftKey) {
          item.selectUpTo(modified);
        } else if (modified) {
          item.toggleSelect();
        } else {
          widget.setSelectedItems([item.getId()]);
        }
        if (!event.shiftKey) {
          widget.getDataRef<{ selectUpToAnchorId?: string | null }>().current.selectUpToAnchorId = item.getId();
        }
        if (!event.shiftKey && !modified) {
          node.open?.();
        }
      },
    };
  };

  const renderItem = (item: ItemInstance<Item>): VNode | VNode[] | null => {
    const { node } = item.getItemData();
    if (node === undefined) {
      return null;
    }
    if (node.kind === "file") {
      return (
        <TreeFileRow
          key={item.getKey()}
          file={node.file}
          state={state}
          notes={notes[node.file.path] ?? []}
          showDir={node.showDir}
          item={{
            props: item.getProps(),
            selected: item.isSelected(),
            onTick: (on) => tickItem(item, on, widget),
          }}
        />
      );
    }

    const done = node.files.filter(isTicked).length;
    const open = item.isExpanded();
    const folder: FolderHead = {
      open,
      toggle: () => (open ? item.collapse() : item.expand()),
      done,
      total: node.files.length,
    };
    const headContent = (
      <>
        <input
          class="tick small"
          type="checkbox"
          checked={node.files.length > 0 && done === node.files.length}
          indeterminate={done > 0 && done < node.files.length}
          aria-label={`Tick every file in ${node.name}`}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => tickItem(item, event.currentTarget.checked, widget)}
        />
        {node.head(folder)}
        {node.count && (
          <span class="tree-count">
            {done}/{node.files.length}
          </span>
        )}
        {node.tail?.(folder)}
      </>
    );
    const children = open ? (childrenOf.get(item.getId()) ?? []).flatMap((child) => renderItem(child) ?? []) : [];
    const selected = item.isSelected() ? "is-selected" : "";
    if (node.layout.kind === "inline") {
      return [
        <li {...propsOf(item, node)} key={item.getKey()} class={`${node.layout.head} ${selected}`}>
          {headContent}
        </li>,
        ...children,
      ];
    }
    return (
      <li class={node.layout.wrap} key={item.getKey()}>
        <div {...propsOf(item, node)} class={`${node.layout.head} ${selected}`}>
          {headContent}
        </div>
        {open && (
          <ul class={node.layout.list} role="group">
            {children}
          </ul>
        )}
      </li>
    );
  };

  return (
    <Container {...widget.getContainerProps(label)} class={rootClass}>
      {(childrenOf.get(rootId) ?? []).flatMap((item) => renderItem(item) ?? [])}
    </Container>
  );
};

/** read files first - they gather as pills at the top of their list - then
    the rest, each part in its own order */
export const readFirst = (state: ReadingState, list: ContentsNode[]): ContentsNode[] => {
  const ticked = (node: ContentsNode): boolean => node.kind === "file" && state.ticked.has(tickKeyOf(node.file));
  return [...list.filter(ticked), ...list.filter((node) => !ticked(node))];
};
