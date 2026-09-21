/* which lines two texts share, by Myers' shortest edit script - what the 3-way
   view aligns its panes and colours its lines from. Monaco has its own diff,
   but only behind a diff editor; this runs synchronously on plain arrays. */

export type LineMatch = {
  /** for each line of `a`, the index of the line of `b` it matched, or -1 */
  aToB: Int32Array;
  /** for each line of `b`, the index of the line of `a` it matched, or -1 */
  bToA: Int32Array;
};

/** past this many edits the middle of the two texts is treated as wholly
    changed rather than searched further - the cost grows with its square */
const maxEdits = 1_500;

export const matchLines = (a: readonly string[], b: readonly string[]): LineMatch => {
  const aToB = new Int32Array(a.length).fill(-1);
  const bToA = new Int32Array(b.length).fill(-1);
  const pair = (x: number, y: number) => {
    aToB[x] = y;
    bToA[y] = x;
  };

  // the common head and tail cost nothing to match, and are most of a file
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pair(start, start);
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    pair(endA, endB);
  }

  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) {
    return { aToB, bToA };
  }

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // v after each step d, for diagonals -d..d only - a whole copy per step
  // would cost the square of the file's length instead of the edit count's
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ?
          (v[offset + k + 1] ?? 0)
        : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        backtrack(trace, n, m, (xi, yi) => pair(start + xi, start + yi));
        return { aToB, bToA };
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return { aToB, bToA };
};

const backtrack = (
  trace: Int32Array[],
  n: number,
  m: number,
  pair: (x: number, y: number) => void,
): void => {
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1];
    if (previous === undefined) {
      break;
    }
    const at = (k: number): number => previous[k + d - 1] ?? 0;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      pair(x, y);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pair(x, y);
  }
};
