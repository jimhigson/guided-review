import { useEffect, useRef } from "preact/hooks";

import { type ContentsMode, contentsModeStore, setContentsMode } from "../contentsMode.ts";
import { type ReadingState } from "../readingState.ts";
import { useStore } from "../stores.ts";
import { DiffSizeOrder } from "./DiffSizeOrder.tsx";
import { FsTree } from "./FsTree.tsx";
import { GuidedOrder } from "./GuidedOrder.tsx";

export type SidebarProps = { state: ReadingState };

export const Sidebar = ({ state }: SidebarProps) => {
  const contentsMode = useStore(contentsModeStore);
  const modeSelectRef = useRef<HTMLSelectElement>(null);

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
        <label
          class="control select"
          onClick={(event) => {
            // a native select only opens its popup for a click landing on its
            // own (text-sized) box - clicking the rest of the label's
            // clickable-looking rectangle would otherwise just focus it.
            // showPicker() isn't in Safari yet, so there it only focuses too
            const modeSelect = modeSelectRef.current;
            if (modeSelect !== null && event.target !== modeSelect) {
              if (typeof modeSelect.showPicker === "function") {
                modeSelect.showPicker();
              } else {
                modeSelect.focus();
              }
            }
          }}
        >
          <span>view</span>
          <select
            ref={modeSelectRef}
            value={contentsMode}
            aria-label="Contents view"
            onChange={(event) => setContentsMode(event.currentTarget.value as ContentsMode)}
          >
            <option value="guided">chapters</option>
            <option value="tree">fs tree</option>
            <option value="size">diff size</option>
          </select>
        </label>
      </div>
      <nav>
        {contentsMode === "tree" ? <FsTree state={state} />
        : contentsMode === "size" ? <DiffSizeOrder state={state} />
        : <GuidedOrder state={state} />}
      </nav>
    </aside>
  );
};
