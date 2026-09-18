import { sides } from "./payload.ts";

const linesOf = (text: string): string[] => text.split(/\r?\n/);

/** the 1-based line of the modified side where the diff's first change
    starts: the first line past everything the two sides share from the top.
    Undefined when there is no modified side to land on - an image, a deleted
    file, or before and after identical. */
const compute = (path: string): number | undefined => {
  const side = sides[path];
  if (side === undefined || side.after === "" || side.before === side.after) {
    return undefined;
  }
  const before = linesOf(side.before);
  const after = linesOf(side.after);
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) {
    index++;
  }
  // a change that only removes lines off the end still lands on the last
  // line there is
  return Math.min(index + 1, after.length);
};

const cache = new Map<string, number | undefined>();

/** memoised per path - each file row asks on every render, and the answer
    only depends on the review as built */
export const firstChangedLine = (path: string): number | undefined => {
  if (!cache.has(path)) {
    cache.set(path, compute(path));
  }
  return cache.get(path);
};
