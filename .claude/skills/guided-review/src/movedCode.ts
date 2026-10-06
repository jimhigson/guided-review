/* the moved code build.ts found in each file - which lines of a diff arrived
   from somewhere else, or left for it - so the editors can box them and the
   rows can say how much of a file is new to read */

import { files, moves, sides } from "./payload.ts";
import { type MovedRun, type ReviewFile } from "./ReviewPayload.ts";

export const movedRunsOf = (key: string): MovedRun[] => moves?.[key] ?? [];

/** the non-blank lines of one side its runs account for, edits aside -
    blank lines aren't code, and an edit is exactly what still needs reading */
const movedLineCount = (key: string, side: MovedRun["side"]): number => {
  const text = side === "after" ? sides[key]?.after : sides[key]?.before;
  if (text === undefined) {
    return 0;
  }
  const lines = text.split(/\r\n|\r|\n/);
  let count = 0;
  for (const run of movedRunsOf(key).filter((candidate) => candidate.side === side)) {
    const edited = new Set(run.edited);
    for (let line = run.start; line <= run.end; line++) {
      if (!edited.has(line) && (lines[line - 1] ?? "").trim() !== "") {
        count++;
      }
    }
  }
  return count;
};

/** how many of a file's added lines moved in from elsewhere, and how many of
    its removed ones moved out to somewhere else */
export const movedLinesOf = (key: string): { movedIn: number; movedOut: number } => ({
  movedIn: movedLineCount(key, "after"),
  movedOut: movedLineCount(key, "before"),
});

/* the app's own goTo, handed over once it exists - a move's label lives in
   monaco's dom, outside the component tree that could pass it down */
let openFile: (file: ReviewFile) => void = () => {};

export const setMovedCodeOpener = (open: (file: ReviewFile) => void): void => {
  openFile = open;
};

/** the row the other end of a move is listed under, read in the same commit -
    undefined when the review leaves that file out */
export const rowOf = (path: string, commit: string | undefined): ReviewFile | undefined =>
  files.find((file) => file.path === path && file.commit === commit);

export const openRow = (file: ReviewFile): void => openFile(file);
