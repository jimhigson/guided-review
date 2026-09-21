/* How the 3-way view's panes - current | resolution | incoming - line up, and
 * what colour each line is. Pure: lines in, zones and marks out.
 *
 * Alignment works from sync lines: resolution lines that both sides carry
 * unchanged. Between two consecutive sync lines each pane has a stretch of its
 * own (maybe empty); every stretch is padded to the tallest of the three, so
 * the next sync line sits at the same height in all of them. Note threads,
 * which only the resolution pane has, count towards its stretch's height -
 * the other two are padded to match them too.
 *
 * The ancestor feeds the colours only: a line a side had that the resolution
 * doesn't is either an ancestor line the other side removed (expected) or that
 * side's own change, dropped - the thing most worth checking in a resolution.
 */

import { type LineMatch, matchLines } from "./lineDiff.ts";

export type Zone = { afterLineNumber: number; heightInPx: number };

/** resolution lines: carried from one side only, or neither (the resolver's
    own). Side lines: not carried into the resolution, split by whether the
    ancestor had them */
export type LineMark = "fromCurrent" | "fromIncoming" | "resolver" | "removed" | "dropped";

export type PaneLayout = {
  pads: Zone[];
  /** 1-based line numbers per mark */
  marks: Partial<Record<LineMark, number[]>>;
};

export type ThreeWayLayout = {
  current: PaneLayout;
  resolution: PaneLayout;
  incoming: PaneLayout;
};

const push = (marks: PaneLayout["marks"], mark: LineMark, line: number): void => {
  (marks[mark] ??= []).push(line);
};

/** side lines missing from the resolution: dropped when the side had changed
    them from the ancestor, merely removed when they were the ancestor's */
const sideMarks = (toResolution: LineMatch, fromAncestor: LineMatch): PaneLayout["marks"] => {
  const marks: PaneLayout["marks"] = {};
  toResolution.aToB.forEach((matched, index) => {
    if (matched === -1) {
      push(marks, fromAncestor.bToA[index] === -1 ? "dropped" : "removed", index + 1);
    }
  });
  return marks;
};

/**
 * the sides never change, so their matches against the ancestor are made
 * once; the returned function lays out a resolution as it is edited
 */
export const threeWayLayouter = (
  current: readonly string[],
  incoming: readonly string[],
  ancestor: readonly string[],
  lineHeight: number,
) => {
  const ancestorToCurrent = matchLines(ancestor, current);
  const ancestorToIncoming = matchLines(ancestor, incoming);

  return (resolution: readonly string[], noteZones: readonly Zone[]): ThreeWayLayout => {
    const currentToResolution = matchLines(current, resolution);
    const incomingToResolution = matchLines(incoming, resolution);

    const resolutionMarks: PaneLayout["marks"] = {};
    // 0-based [current, resolution, incoming], bracketed by virtual lines
    // before the first and after the last
    const syncs: [number, number, number][] = [[-1, -1, -1]];
    resolution.forEach((_, index) => {
      const inCurrent = currentToResolution.bToA[index] ?? -1;
      const inIncoming = incomingToResolution.bToA[index] ?? -1;
      if (inCurrent !== -1 && inIncoming !== -1) {
        syncs.push([inCurrent, index, inIncoming]);
      } else {
        push(
          resolutionMarks,
          inCurrent !== -1 ? "fromCurrent"
          : inIncoming !== -1 ? "fromIncoming"
          : "resolver",
          index + 1,
        );
      }
    });
    syncs.push([current.length, resolution.length, incoming.length]);

    const pads: [Zone[], Zone[], Zone[]] = [[], [], []];
    const zones = [...noteZones].sort((a, b) => a.afterLineNumber - b.afterLineNumber);
    for (let index = 1; index < syncs.length; index++) {
      const from = syncs[index - 1];
      const to = syncs[index];
      if (from === undefined || to === undefined) {
        continue;
      }
      const heights = [0, 1, 2].map((pane) => {
        const lines = (to[pane] ?? 0) - (from[pane] ?? 0) - 1;
        // zones after the opening sync line up to the stretch's last line
        const zoneHeight =
          pane === 1 ?
            zones
              .filter(
                (zone) =>
                  zone.afterLineNumber >= (from[1] ?? 0) + 1 && zone.afterLineNumber <= (to[1] ?? 0),
              )
              .reduce((sum, zone) => sum + zone.heightInPx, 0)
          : 0;
        return lines * lineHeight + zoneHeight;
      });
      const tallest = Math.max(...heights);
      heights.forEach((height, pane) => {
        if (height < tallest) {
          // right before the closing sync line, which is what has to line up
          pads[pane]?.push({ afterLineNumber: to[pane] ?? 0, heightInPx: tallest - height });
        }
      });
    }

    return {
      current: { pads: pads[0], marks: sideMarks(currentToResolution, ancestorToCurrent) },
      resolution: { pads: pads[1], marks: resolutionMarks },
      incoming: { pads: pads[2], marks: sideMarks(incomingToResolution, ancestorToIncoming) },
    };
  };
};
