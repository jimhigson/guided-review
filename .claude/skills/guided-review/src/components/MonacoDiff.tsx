import { useEffect, useRef, useState } from "preact/hooks";

import {
  createDiffEditor,
  type DiffEditorControls,
  type EditorStatus,
} from "../createDiffEditor.tsx";
import { diffViewStore } from "../diffView.ts";
import { loadMonaco } from "../monacoLoader.ts";
import { activeReviewIsEditable, conflict, server, sides } from "../payload.ts";
import { useStore } from "../stores.ts";

/** what each 3-way colour means, in the order they're worth checking */
const threeWayKey = [
  ["resolver", "the resolver's own line - in neither side"],
  ["dropped", "a side's own change, left out of the resolution"],
  ["fromIncoming", "carried from incoming"],
  ["fromCurrent", "carried from current"],
  ["removed", "an ancestor line the other side removed"],
] as const;

/** a side that had the file at another path says where - the file was
    moved, and the pane shows it from there */
const MovedFrom = ({ path }: { path: string | undefined }) =>
  path === undefined ? null : (
    <span class="tw-moved" title={`on this side the file is at ${path}`}>
      at <code>{path}</code>
    </span>
  );

/** the three panes' headings and the key to their colours */
const ThreeWayHead = ({ path }: { path: string }) => {
  const side = sides[path];
  if (conflict === undefined) {
    return null;
  }
  return (
    <>
      <div class="three-way-head">
        <span title={conflict.current.detail}>
          <strong>Current</strong> <code>{conflict.current.label}</code>{" "}
          <MovedFrom path={side?.currentPath} />
        </span>
        <span>
          <strong>Resolution</strong>
        </span>
        <span title={conflict.incoming.detail}>
          <strong>Incoming</strong> <code>{conflict.incoming.label}</code>{" "}
          <MovedFrom path={side?.incomingPath} />
        </span>
      </div>
      <p class="three-way-key">
        {threeWayKey.map(([mark, meaning]) => (
          <span key={mark}>
            <span class={`tw-swatch tw-${mark}`} aria-hidden="true" />
            {meaning}
          </span>
        ))}
      </p>
    </>
  );
};

export type MonacoDiffProps = {
  path: string;
  fileStatus: string;
  setCounts: (counts: [number, number]) => void;
};

export const MonacoDiff = ({
  path,
  fileStatus,
  setCounts,
}: MonacoDiffProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const controls = useRef<DiffEditorControls | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<EditorStatus>({ kind: "", text: "" });
  const threeWay =
    useStore(diffViewStore) === "threeWay" && sides[path]?.incoming !== undefined;

  useEffect(() => {
    if (sides[path] === undefined) {
      return;
    }
    let live = true;
    loadMonaco()
      .then((monaco) => {
        const host = hostRef.current;
        if (!live || host === null) {
          return;
        }
        controls.current = createDiffEditor(monaco, host, path, fileStatus, {
          setCounts,
          setDirty,
          setStatus,
        });
      })
      .catch((error: Error) => {
        // monaco is a dependency, not an enhancement - failing to get it is a
        // failure to show, not a mode to degrade into
        if (live) {
          setLoadError(error.message);
        }
      });
    return () => {
      live = false;
      controls.current?.dispose();
      controls.current = undefined;
    };
  }, [path, fileStatus, setCounts]);

  if (sides[path] === undefined) {
    return (
      <p class="diff-missing">
        not embedded — longer than <code>--max-side-lines</code> when this
        review was built; read the file in the tree itself
      </p>
    );
  }

  if (loadError !== undefined) {
    return <p class="diff-error">code diff unavailable: {loadError}</p>;
  }

  const editable = activeReviewIsEditable();

  return (
    <>
      {threeWay && <ThreeWayHead path={path} />}
      <div class="diff-monaco" ref={hostRef} />
      <div class="editor-bar">
        <span class="hint">
          {server === undefined ?
            "read-only — serve this review to edit and leave notes"
          : editable ?
            "editable — hover a line and click + to add a note"
          : "read-only — the served checkout is on another review's branch; notes still work"
          }
        </span>
        <span class={status.kind}>{status.text}</span>
        {editable && (
          <button
            type="button"
            class="save revert"
            title="back to the content this review was built from"
            onClick={() => controls.current?.revert()}
          >
            Revert
          </button>
        )}
        {editable && (
          <button
            type="button"
            class="save"
            disabled={!dirty}
            onClick={() => controls.current?.save()}
          >
            Save
          </button>
        )}
      </div>
    </>
  );
};
