/* how many lines a change adds and removes, worked out in the page - for a
   row whose content the page itself has replaced, with nothing from git to
   count it */

import { matchLines } from "./lineDiff.ts";

const linesOf = (text: string): string[] => {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

export const lineCounts = (before: string, after: string): [number, number] => {
  const { aToB, bToA } = matchLines(linesOf(before), linesOf(after));
  return [bToA.filter((index) => index === -1).length, aToB.filter((index) => index === -1).length];
};
