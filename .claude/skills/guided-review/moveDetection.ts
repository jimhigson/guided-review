/* Finding code a change moved rather than wrote - shared by moves.ts, which
 * prints it for the agent writing the review, and build.ts, which embeds it in
 * the page so the diff editors can say which code arrived from elsewhere.
 *
 * The removed code is indexed as one stream of tokens - names, literals,
 * punctuation, comments - with whitespace and line breaks gone, so neither
 * re-indenting nor prettier re-wrapping a call (nor the trailing comma it adds
 * when it does) hides a move. The added code is looked up against it a window
 * of tokens at a time, and each hit extended as far as it goes both ways.
 * Matches can start and end mid-line: a line wholly matched is moved, and a
 * line only partly matched is an edit made on the way, with the part that
 * moved still known.
 *
 * A match stands on its own when it is detailed enough and its code occurred
 * once in what was removed - then there is nowhere else it can have come
 * from, so one line is enough. Common code (`false,`, `return;`) only counts
 * inside a block anchored by something distinctive. Matches a few lines apart
 * in the same pair of files are one block, and what lies between them is the
 * block's residual: the only part of a moved block that needs reading.
 * Imports never take part: a split scatters them across every new file.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type MovedRun } from "./src/ReviewPayload.ts";

export type DiffLine = {
  path: string;
  /** the path the review lists this line's file under: the new one, for a
      line removed from a renamed file */
  row: string;
  line: number;
  /** which hunk of the diff it is in, numbered across the whole diff - a
      line whole files added outside any diff are in none (-1) */
  hunk: number;
  text: string;
  /** what lines are compared by - indentation and whitespace runs dropped */
  key: string;
  /** what a line counts for: zero for blank lines and punctuation */
  weight: number;
};

/** a line inside a moved block that isn't wholly the moved code: `moved` is
    which of its columns did come along (1-based, end exclusive), if any */
export type EditedLine = { line: number; text: string; moved: [number, number][] };

/** one edit inside a moved block: what was there, and what replaced it */
export type Edit = { removed: EditedLine[]; added: EditedLine[] };

/** one end of a move: where the block is, in one file on one side */
export type MoveEnd = { path: string; row: string; start: number; end: number };

export type Move = {
  from: MoveEnd;
  to: MoveEnd;
  /** non-blank lines where the block landed */
  lines: number;
  /** destination indent minus source, in columns, of the first matched line */
  indent: number;
  /** the edits made on the way, in order - empty for a verbatim move */
  residual: Edit[];
};

export type FileMoves = {
  path: string;
  removed: number;
  movedOut: number;
  added: number;
  movedIn: number;
  /** added lines that aren't part of any move, imports aside */
  unmatched: { line: number; text: string }[];
};

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1_024 * 1_024 });

const keyOf = (text: string): string => text.trim().replace(/\s+/g, " ");

const isTrivial = (key: string): boolean => /^[\s{}()[\];,:]*$/.test(key);

const toLine = (path: string, line: number, text: string, row = path, hunk = -1): DiffLine => {
  const key = keyOf(text);
  return { path, row, line, hunk, text, key, weight: isTrivial(key) ? 0 : key.length };
};

/** which lines are import or re-export statements, a multi-line one's
    names included - an extraction always brings its imports, so they aren't
    news */
const importLines = (added: DiffLine[]): Set<DiffLine> => {
  const imports = new Set<DiffLine>();
  let open = false;
  added.forEach((line, index) => {
    if (!follows(added, index)) {
      open = false;
    }
    const starts = /^(import\b|export (type )?(\*|\{))/.test(line.key);
    if (open || starts) {
      imports.add(line);
      open = !/\bfrom ["']|^import ["']|;$/.test(line.key);
    }
  });
  return imports;
};

/** removed and added lines, each in diff order, from a -U0 unified diff */
const parseDiff = (diff: string): { removed: DiffLine[]; added: DiffLine[] } => {
  const removed: DiffLine[] = [];
  const added: DiffLine[] = [];
  let oldPath = "";
  let newPath = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hunk = -1;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
    } else if (!inHunk && raw.startsWith("--- ")) {
      oldPath = raw.slice(4).replace(/^a\//, "");
    } else if (!inHunk && raw.startsWith("+++ ")) {
      newPath = raw.slice(4).replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match !== null) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
        inHunk = true;
        hunk++;
      }
    } else if (inHunk && raw.startsWith("-")) {
      removed.push(toLine(oldPath, oldLine++, raw.slice(1), newPath === "/dev/null" ? oldPath : newPath, hunk));
    } else if (inHunk && raw.startsWith("+")) {
      added.push(toLine(newPath, newLine++, raw.slice(1), newPath, hunk));
    }
  }
  return { removed, added };
};

/** what a scope's diff is measured as - the same three as changedFiles.sh */
export type MoveScope =
  | { mode: "commit"; ref: string }
  | { mode: "pr"; base: string; head: string }
  | { mode: "worktree" };

export type DiffLines = { removed: DiffLine[]; added: DiffLine[] };

export const collectDiffLines = (repo: string, scope: MoveScope): DiffLines => {
  const flags = ["-U0", "-M", "--no-color", "--no-ext-diff"];
  if (scope.mode === "commit") {
    return parseDiff(git(repo, "show", "--format=", ...flags, scope.ref));
  }
  if (scope.mode === "pr") {
    return parseDiff(git(repo, "diff", ...flags, `${scope.base}...${scope.head}`));
  }
  // worktree: tracked changes against HEAD, and untracked files whole
  const lines = parseDiff(git(repo, "diff", ...flags, "HEAD"));
  for (const path of git(repo, "ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
    if (path === "") {
      continue;
    }
    const content = readFileSync(join(repo, path), "utf8");
    if (content.includes("\0")) {
      continue;
    }
    content
      .replace(/\n$/, "")
      .split("\n")
      .forEach((text, index) => lines.added.push(toLine(path, index + 1, text)));
  }
  return lines;
};

/** line i+1 directly follows line i in the same file */
const follows = (lines: DiffLine[], i: number): boolean =>
  i > 0 && lines[i]?.path === lines[i - 1]?.path && lines[i]?.line === (lines[i - 1]?.line ?? 0) + 1;

/** one token of a side's code, and where it sits */
type Token = {
  text: string;
  /** index into that side's DiffLine array */
  at: number;
  /** 1-based columns, end exclusive */
  start: number;
  end: number;
  /** how much it says: a name or literal's length, nothing for punctuation */
  detail: number;
};

const tokenPattern =
  /\/\/.*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d[\w.]*|\S/g;

/** a side's code as one token stream. Where its lines stop being contiguous
    (another file, another hunk) or an import intervenes, a token that equals
    nothing stops a match running across the join */
const tokenise = (lines: DiffLine[]): Token[] => {
  const imports = importLines(lines);
  const tokens: Token[] = [];
  let breaks = 0;
  const stop = (at: number): void => {
    tokens.push({ text: `\u0000${breaks++}`, at, start: 0, end: 0, detail: 0 });
  };
  lines.forEach((line, at) => {
    if (!follows(lines, at) || imports.has(line)) {
      stop(at);
    }
    if (imports.has(line)) {
      return;
    }
    for (const match of line.text.matchAll(tokenPattern)) {
      const text = match[0];
      const start = (match.index ?? 0) + 1;
      tokens.push({
        text,
        at,
        start,
        end: start + text.length,
        detail: /^[\w$"'`/]/.test(text) ? text.length : 0,
      });
    }
  });
  // prettier adds a trailing comma when it wraps a call or literal over lines
  // and takes it away when it fits on one - neither is a change to the code
  return tokens.filter(
    (token, index) => !(token.text === "," && /^[)\]}>]$/.test(tokens[index + 1]?.text ?? "")),
  );
};

/** a stretch of the added stream that is the same tokens as a stretch of the
    removed one */
type Match = {
  r: number;
  a: number;
  length: number;
  /** characters of names and literals */
  detail: number;
  /** how many names and literals */
  words: number;
  unique: boolean;
};

const windowSize = 4;

const windowKey = (tokens: Token[], from: number): string =>
  tokens
    .slice(from, from + windowSize)
    .map((token) => token.text)
    .join("\u0001");

/** a comment or string this long says enough on its own to look up by,
    whatever surrounds it now */
const tellingLength = 20;

const loneKey = (token: Token | undefined): string | undefined =>
  token !== undefined && token.detail >= tellingLength && /^["'`/]/.test(token.text) ?
    `\u0002${token.text}`
  : undefined;

/** every maximal match worth considering - seeded on windows with some
    detail, extended both ways as far as the tokens agree */
const maximalMatches = (
  removed: Token[],
  added: Token[],
  /** an edit in place, not a move: the two tokens are in the same hunk of the same file */
  inPlace: (r: number, a: number) => boolean,
): Match[] => {
  const seeds = new Map<string, number[]>();
  for (let r = 0; r + windowSize <= removed.length; r++) {
    const window = removed.slice(r, r + windowSize);
    if (window.filter((token) => token.detail > 0).length >= 2) {
      const key = windowKey(removed, r);
      seeds.set(key, [...(seeds.get(key) ?? []), r]);
    }
  }
  removed.forEach((token, r) => {
    const key = loneKey(token);
    if (key !== undefined) {
      seeds.set(key, [...(seeds.get(key) ?? []), r]);
    }
  });

  const matches: Match[] = [];
  // a match found once needn't be found again from each of its windows
  const reachedOnDiagonal = new Map<number, number>();
  for (let a = 0; a < added.length; a++) {
    const lone = loneKey(added[a]);
    const hits = [
      ...(a + windowSize <= added.length ? (seeds.get(windowKey(added, a)) ?? []) : []),
      ...(lone === undefined ? [] : (seeds.get(lone) ?? [])),
    ];
    if (hits.length > 50) {
      continue;
    }
    for (const seed of hits) {
      const diagonal = a - seed;
      if ((reachedOnDiagonal.get(diagonal) ?? -1) > a || inPlace(seed, a)) {
        continue;
      }
      let r = seed;
      let start = a;
      while (r > 0 && start > 0 && removed[r - 1]?.text === added[start - 1]?.text) {
        r--;
        start--;
      }
      let length = 0;
      while (removed[r + length] !== undefined && removed[r + length]?.text === added[start + length]?.text) {
        length++;
      }
      reachedOnDiagonal.set(diagonal, start + length);
      const matched = added.slice(start, start + length);
      const detail = matched.reduce((sum, token) => sum + token.detail, 0);
      const words = matched.filter((token) => token.detail > 0).length;
      // its code occurred once in what was removed: a window of it did, or a
      // telling comment or string in it did
      let unique = false;
      for (let offset = 0; offset < length && !unique; offset++) {
        const lone = loneKey(removed[r + offset]);
        unique =
          (offset + windowSize <= length && (seeds.get(windowKey(removed, r + offset))?.length ?? 0) === 1) ||
          (lone !== undefined && (seeds.get(lone)?.length ?? 0) === 1);
      }
      matches.push({ r, a: start, length, detail, words, unique });
    }
  }
  return matches;
};

const leadingColumns = (text: string): number => (/^\s*/.exec(text.replace(/\t/g, "  "))?.[0].length ?? 0);

export type MoveThresholds = {
  /** detail (characters of names and literals) a match needs to count on its
      own, when its code occurred once in what was removed */
  minChars: number;
  /** ...and how many names and literals - `run(x)` is too plain to be sure of */
  minWords: number;
  /** ...and when it didn't - long enough to be no coincidence */
  minCharsCommon: number;
  /** lines between matches that still leaves them one block */
  maxGap: number;
};

export const defaultThresholds: MoveThresholds = {
  minChars: 24,
  minWords: 3,
  minCharsCommon: 120,
  maxGap: 4,
};

export const findMoves = (
  removed: DiffLine[],
  added: DiffLine[],
  { minChars, minWords, minCharsCommon, maxGap }: MoveThresholds = defaultThresholds,
): Move[] => {
  const rTokens = tokenise(removed);
  const aTokens = tokenise(added);
  const inPlace = (r: number, a: number): boolean => {
    const from = removed[rTokens[r]?.at ?? -1];
    const to = added[aTokens[a]?.at ?? -1];
    return from !== undefined && to !== undefined && from.hunk === to.hunk && from.row === to.path;
  };

  // longest first, each token belonging to at most one match on each side;
  // where a match overlaps one already taken, what is left of it still counts
  const usedR = new Uint8Array(rTokens.length);
  const usedA = new Uint8Array(aTokens.length);
  const taken: Match[] = [];
  const candidates = maximalMatches(rTokens, aTokens, inPlace).sort((x, y) => y.detail - x.detail);
  for (const match of candidates) {
    let offset = 0;
    while (offset < match.length) {
      while (offset < match.length && (usedR[match.r + offset] === 1 || usedA[match.a + offset] === 1)) {
        offset++;
      }
      const from = offset;
      while (offset < match.length && usedR[match.r + offset] === 0 && usedA[match.a + offset] === 0) {
        offset++;
      }
      if (offset > from) {
        const length = offset - from;
        const part = aTokens.slice(match.a + from, match.a + offset);
        const detail = part.reduce((sum, token) => sum + token.detail, 0);
        if (detail === 0) {
          continue;
        }
        const words = part.filter((token) => token.detail > 0).length;
        taken.push({ r: match.r + from, a: match.a + from, length, detail, words, unique: match.unique });
        usedR.fill(1, match.r + from, match.r + offset);
        usedA.fill(1, match.a + from, match.a + offset);
      }
    }
  }

  // matches a few lines apart, in order, between the same two files, are one
  // block - and a block is only kept for something in it that can't be chance
  type Block = { matches: Match[] };
  const lineOf = (tokens: Token[], lines: DiffLine[], index: number): DiffLine | undefined =>
    lines[tokens[index]?.at ?? -1];
  const contiguous = (lines: DiffLine[], from: number, to: number): boolean => {
    for (let i = from + 1; i <= to; i++) {
      if (!follows(lines, i)) return false;
    }
    return true;
  };
  const blocks: Block[] = [];
  for (const match of [...taken].sort((x, y) => x.a - y.a)) {
    const rFirst = rTokens[match.r]?.at ?? 0;
    const aFirst = aTokens[match.a]?.at ?? 0;
    const last = blocks.findLast((block) => {
      const previous = block.matches[block.matches.length - 1];
      if (previous === undefined || match.r < previous.r + previous.length) {
        return false;
      }
      const rLast = rTokens[previous.r + previous.length - 1]?.at ?? 0;
      const aLast = aTokens[previous.a + previous.length - 1]?.at ?? 0;
      return (
        rFirst - rLast <= maxGap + 1 &&
        aFirst - aLast <= maxGap + 1 &&
        contiguous(removed, rLast, rFirst) &&
        contiguous(added, aLast, aFirst)
      );
    });
    if (last === undefined) {
      blocks.push({ matches: [match] });
    } else {
      last.matches.push(match);
    }
  }

  const moves: Move[] = [];
  for (const block of blocks) {
    const anchored = block.matches.some(
      (match) =>
        (match.unique && match.detail >= minChars && match.words >= minWords) ||
        match.detail >= minCharsCommon,
    );
    const first = block.matches[0];
    const final = block.matches[block.matches.length - 1];
    if (!anchored || first === undefined || final === undefined) {
      continue;
    }
    const startR = lineOf(rTokens, removed, first.r);
    const startA = lineOf(aTokens, added, first.a);
    const endR = lineOf(rTokens, removed, final.r + final.length - 1);
    const endA = lineOf(aTokens, added, final.a + final.length - 1);
    if (startR === undefined || startA === undefined || endR === undefined || endA === undefined) {
      continue;
    }
    const rFrom = rTokens[first.r]?.at ?? 0;
    const rTo = rTokens[final.r + final.length - 1]?.at ?? 0;
    const aFrom = aTokens[first.a]?.at ?? 0;
    const aTo = aTokens[final.a + final.length - 1]?.at ?? 0;

    // which columns of each line in the block the matches cover
    const coverage = (tokens: Token[], from: number, to: number, side: "r" | "a") => {
      const covered = new Map<number, [number, number][]>();
      const all = new Map<number, number>();
      for (const token of tokens) {
        if (token.at >= from && token.at <= to && token.end > 0) {
          all.set(token.at, (all.get(token.at) ?? 0) + 1);
        }
      }
      const counts = new Map<number, number>();
      for (const match of block.matches) {
        const begin = side === "r" ? match.r : match.a;
        for (let index = begin; index < begin + match.length; index++) {
          const token = tokens[index];
          if (token === undefined) continue;
          counts.set(token.at, (counts.get(token.at) ?? 0) + 1);
          const spans = covered.get(token.at) ?? [];
          const lastSpan = spans[spans.length - 1];
          if (lastSpan !== undefined && index > begin) {
            lastSpan[1] = token.end;
          } else {
            spans.push([token.start, token.end]);
          }
          covered.set(token.at, spans);
        }
      }
      // a moved scrap of punctuation (a `);`) isn't worth showing as moved
      for (const [at, spans] of covered) {
        const text = (side === "r" ? removed : added)[at]?.text ?? "";
        covered.set(
          at,
          spans.filter(([start, end]) => /[\w"'`]/.test(text.slice(start - 1, end - 1))),
        );
      }
      const whole = (at: number): boolean => (counts.get(at) ?? 0) === (all.get(at) ?? 0);
      return { covered, whole };
    };
    const rCover = coverage(rTokens, rFrom, rTo, "r");
    const aCover = coverage(aTokens, aFrom, aTo, "a");

    // the edits are the lines not wholly moved, in runs unbroken by a wholly
    // moved line. A run on one side pairs with the run on the other that
    // comes after the same number of matches - whatever stayed the same is
    // the anchor - counted from the first token of the run that didn't move,
    // since a match can end partway along a line
    const edits = new Map<number, Edit>();
    const lift = (lines: DiffLine[], tokens: Token[], from: number, to: number, side: "r" | "a") => {
      const cover = side === "r" ? rCover : aCover;
      const spans = block.matches.map((match) => {
        const begin = side === "r" ? match.r : match.a;
        return { begin, end: begin + match.length };
      });
      const moved = (index: number): boolean =>
        spans.some((span) => index >= span.begin && index < span.end);
      const firstToken = new Map<number, number>();
      tokens.forEach((token, index) => {
        if (token.at >= from && token.at <= to && token.end > 0 && !moved(index) && !firstToken.has(token.at)) {
          firstToken.set(token.at, index);
        }
      });
      let group: EditedLine[] = [];
      let groupToken = 0;
      const close = (): void => {
        if (group.length === 0) return;
        const key = spans.filter((span) => span.end <= groupToken).length;
        const edit = edits.get(key) ?? { removed: [], added: [] };
        (side === "r" ? edit.removed : edit.added).push(...group);
        edits.set(key, edit);
        group = [];
      };
      for (let at = from; at <= to; at++) {
        const line = lines[at];
        if (line === undefined || line.key === "") continue;
        if (cover.whole(at)) {
          close();
          continue;
        }
        if (group.length === 0) {
          groupToken = firstToken.get(at) ?? 0;
        }
        group.push({ line: line.line, text: line.text, moved: cover.covered.get(at) ?? [] });
      }
      close();
    };
    lift(removed, rTokens, rFrom, rTo, "r");
    lift(added, aTokens, aFrom, aTo, "a");
    const residual = [...edits.entries()].sort(([x], [y]) => x - y).map(([, edit]) => edit);

    const lines = added.slice(aFrom, aTo + 1).filter((line) => line.key !== "").length;
    moves.push({
      from: { path: startR.path, row: startR.row, start: startR.line, end: endR.line },
      to: { path: startA.path, row: startA.row, start: startA.line, end: endA.line },
      lines,
      indent: leadingColumns(startA.text) - leadingColumns(startR.text),
      residual,
    });
  }
  return moves;
};

export const perFile = (removed: DiffLine[], added: DiffLine[], moves: Move[]): FileMoves[] => {
  // in a block, and not one of its edits
  const within = (side: "from" | "to", line: DiffLine): boolean =>
    moves.some(
      (move) =>
        move[side].path === line.path &&
        line.line >= move[side].start &&
        line.line <= move[side].end &&
        !move.residual.some((edit) =>
          (side === "from" ? edit.removed : edit.added).some((edited) => edited.line === line.line),
        ),
    );
  const files = new Map<string, FileMoves>();
  const fileOf = (path: string): FileMoves => {
    const existing = files.get(path);
    if (existing !== undefined) return existing;
    const created: FileMoves = { path, removed: 0, movedOut: 0, added: 0, movedIn: 0, unmatched: [] };
    files.set(path, created);
    return created;
  };
  for (const line of removed) {
    if (line.key === "") continue;
    const file = fileOf(line.path);
    file.removed++;
    if (within("from", line)) file.movedOut++;
  }
  const imports = importLines(added);
  for (const line of added) {
    if (line.key === "") continue;
    const file = fileOf(line.path);
    file.added++;
    if (within("to", line)) file.movedIn++;
    else if (!imports.has(line) && line.weight > 0) file.unmatched.push({ line: line.line, text: line.text });
  }
  return [...files.values()].filter((file) => file.movedIn + file.movedOut > 0);
};

/** each move as the two runs it leaves - one on the side it left, one on the
    side it arrived at - filed under the rows the review lists them by */
export const movedRunsByRow = (moves: Move[]): Record<string, MovedRun[]> => {
  const runs: Record<string, MovedRun[]> = {};
  const file = (row: string, run: MovedRun): void => {
    runs[row] = [...(runs[row] ?? []), run];
  };
  for (const move of moves) {
    file(move.from.row, {
      side: "before",
      start: move.from.start,
      end: move.from.end,
      other: { path: move.to.row, line: move.to.start },
      edited: move.residual.flatMap((edit) => edit.removed.map((line) => line.line)),
      fragments: move.residual.flatMap((edit) =>
        edit.removed.flatMap((line) => line.moved.map(([start, end]) => ({ line: line.line, start, end }))),
      ),
    });
    file(move.to.row, {
      side: "after",
      start: move.to.start,
      end: move.to.end,
      other: { path: move.from.row, line: move.from.start },
      edited: move.residual.flatMap((edit) => edit.added.map((line) => line.line)),
      fragments: move.residual.flatMap((edit) =>
        edit.added.flatMap((line) => line.moved.map(([start, end]) => ({ line: line.line, start, end }))),
      ),
    });
  }
  return runs;
};
