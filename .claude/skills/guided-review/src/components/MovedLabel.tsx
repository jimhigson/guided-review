import { openRow, rowOf } from "../movedCode.ts";
import { basename } from "../paths.ts";
import { type MovedRun } from "../ReviewPayload.ts";

export type MovedLabelProps = {
  run: MovedRun;
  /** the file the run is in */
  path: string;
  commit: string | undefined;
};

/** the tab above a moved block in a diff: where the block came from (or went
    to), and whether it changed on the way - with the far end a link, when the
    review lists that file */
export const MovedLabel = ({ run, path, commit }: MovedLabelProps) => {
  const arrived = run.side === "after";
  const sameFile = run.other.path === path;
  const target = sameFile ? undefined : rowOf(run.other.path, commit);
  const where = `${basename(run.other.path)}:${run.other.line}`;
  const edits =
    run.edited.length === 0 ? "verbatim" : `${run.edited.length} line(s) edited on the way`;

  return (
    <div class="moved-zone">
      <div class={`moved-label ${arrived ? "moved-in" : "moved-out"}`}>
        <span class="moved-label-icon" aria-hidden="true" />
        {sameFile ?
          <span>
            moved within this file, {arrived ? "from" : "to"} line {run.other.line}
          </span>
        : <span>
            {arrived ? "moved here from " : "moved to "}
            {target === undefined ?
              <code title={`${run.other.path} - not in this review`}>{where}</code>
            : <button
                type="button"
                class="moved-link"
                title={`Go to ${run.other.path}`}
                onClick={() => openRow(target)}
              >
                {where}
              </button>
            }
          </span>
        }
        <span class="moved-edits"> · {edits}</span>
      </div>
    </div>
  );
};
