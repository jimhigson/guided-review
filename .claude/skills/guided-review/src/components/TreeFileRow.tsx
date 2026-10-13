import { isImagePath } from "../imagePaths.ts";
import { awaitingReply, messagesOf, type Note } from "../notes.ts";
import { basename, dirname } from "../paths.ts";
import { tickKeyOf } from "../payload.ts";
import { type ReadingState } from "../readingState.ts";
import { type ReviewFile } from "../ReviewPayload.ts";
import { FileStatusChip } from "./FileStatusChip.tsx";
import { TruncatedPathLabel } from "./PathLabel.tsx";

/** a row that is an item of a keyboard-driven tree widget, rather than a
    plain list entry: the widget owns focus, selection and what a click does */
export type TreeItemBinding = {
  /** the widget's props for the item's element - role, aria, tabindex, the
      click that selects and opens it */
  props: Record<string, unknown>;
  selected: boolean;
  /** ticking it - which may tick everything selected along with it */
  onTick: (on: boolean) => void;
};

export type TreeFileRowProps = {
  file: ReviewFile;
  state: ReadingState;
  notes: Note[];
  /** the fs tree already shows a file's directory in its nesting, so it hides this */
  showDir: boolean;
  item?: TreeItemBinding;
};

/** one file in a contents list: its tick, status/size chip, and a link that
    scrolls the reading order to it - shared by every contents view. Once
    ticked it shrinks to a pill of just the tick and name, which the list
    flows inline with its ticked neighbours to save vertical space */
export const TreeFileRow = ({ file, state, notes, showDir, item }: TreeFileRowProps) => {
  const ticked = state.ticked.has(tickKeyOf(file));
  const waiting = notes.filter((note) => awaitingReply(messagesOf(note))).length;
  const label = (
    <>
      {!ticked && (
        <span
          class={`file-icon ${isImagePath(file.path) ? "file-icon-image" : "file-icon-text"}`}
          aria-hidden="true"
        />
      )}
      <span class="tree-base">{basename(file.path)}</span>
      {showDir && !ticked && <TruncatedPathLabel class="tree-dir" path={dirname(file.path)} />}
    </>
  );
  return (
    <li
      {...item?.props}
      class={`tree-file tree-file-${file.status} ${ticked ? "is-ticked" : ""} ${state.activeId === file.id ? "is-active" : ""} ${item?.selected === true ? "is-selected" : ""}`}
    >
      <input
        class="tick small"
        type="checkbox"
        checked={ticked}
        aria-label={`Read ${file.path}`}
        // in a tree the item is the one tab stop, and ticking isn't selecting
        tabIndex={item === undefined ? undefined : -1}
        onClick={item === undefined ? undefined : (event) => event.stopPropagation()}
        onChange={(event) =>
          item === undefined ?
            state.tickFile(file, event.currentTarget.checked)
          : item.onTick(event.currentTarget.checked)
        }
      />
      {!ticked && <FileStatusChip path={file.path} status={file.status} />}
      {/* a tree's item is itself what's clicked and focused; a button inside
          it would be a second tab stop doing the same thing */}
      {item === undefined ?
        <button type="button" class="tree-file-link" title={file.path} onClick={() => state.goTo(file)}>
          {label}
        </button>
      : <span class="tree-file-link" title={file.path}>
          {label}
        </span>
      }
      {/* outlined while any thread waits on the agent, filled once it has
          answered them all - kept on a ticked file too, since a reply
          landing there is exactly what's worth noticing */}
      {notes.length > 0 && (
        <span
          class={`note-count note-bubble ${waiting > 0 ? "is-waiting" : "is-answered"}`}
          title={
            waiting > 0 ?
              `${notes.length} note(s), ${waiting} waiting on the agent`
            : `${notes.length} note(s), all answered by the agent`
          }
        >
          {notes.length}
        </span>
      )}
    </li>
  );
};
