import { useEffect } from "preact/hooks";

import { type ContentsMode, contentsModeStore, setContentsMode } from "../contentsMode.ts";
import { type ReadingState } from "../readingState.ts";
import { useStore } from "../stores.ts";
import { DiffSizeOrder } from "./DiffSizeOrder.tsx";
import { FsTree } from "./FsTree.tsx";
import { GuidedOrder } from "./GuidedOrder.tsx";
import { SelectControl } from "./SelectControl.tsx";

export type SidebarProps = { state: ReadingState };

export const Sidebar = ({ state }: SidebarProps) => {
  const contentsMode = useStore(contentsModeStore);

  // whichever file the main pane is on stays in view here too, so the
  // contents keeps tracking the reading order without being scrolled to by hand
  useEffect(() => {
    document
      .querySelector(".sidebar .tree-file.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [state.activeId]);

  return (
    <aside class="sidebar" id="contents" aria-label="Contents">
      <div class="sidebar-head">
        <SelectControl
          label="view"
          ariaLabel="Contents view"
          value={contentsMode}
          onChange={(mode) => setContentsMode(mode as ContentsMode)}
        >
          <option value="guided">chapters</option>
          <option value="tree">fs tree</option>
          <option value="size">diff size</option>
        </SelectControl>
      </div>
      <nav>
        {contentsMode === "tree" ? <FsTree state={state} />
        : contentsMode === "size" ? <DiffSizeOrder state={state} />
        : <GuidedOrder state={state} />}
      </nav>
    </aside>
  );
};
