/* Which files a change touched only mechanically - nothing in them a reader
 * needs to think about - so a review can offer to tick them as read before
 * reading starts. Shared by mechanical.ts, which prints them for the agent to
 * ask about, and build.ts, which marks them in the page.
 *
 * Each hunk of a file's diff is mechanical when it is one of:
 *   - imports: every changed line is an import or re-export
 *   - reformatting: the same tokens once whitespace and the trailing commas
 *     prettier adds and removes are set aside
 *   - a rename: the same tokens but for names swapped one for another, where
 *     the old name is gone from the branch altogether - so a call switched to
 *     some other existing function doesn't pass for one
 *   - moved: code moved here or away verbatim (moveDetection.ts)
 * A file is mechanical only when every hunk of it is. Anything else - a
 * changed literal, a line added or dropped, a rename of something still used
 * elsewhere - leaves the file for reading.
 */

import { execFileSync } from "node:child_process";

import { type DiffLine, type DiffLines, importLines, type Move, tokenPattern } from "./moveDetection.ts";

export type Mechanical = Record<string, string>;

const identifier = /^[A-Za-z_$][\w$]*$/;

const tokensOf = (lines: DiffLine[]): string[] => {
  const tokens = lines.flatMap((line) => [...line.text.matchAll(tokenPattern)].map((match) => match[0]));
  return tokens.filter((token, index) => !(token === "," && /^[)\]}>]$/.test(tokens[index + 1] ?? "")));
};

/** whether an identifier still appears anywhere in the branch as it is now */
const stillUsed = (repo: string, name: string, at: string | undefined): boolean => {
  try {
    execFileSync("git", ["grep", "-q", "-w", "-e", name, ...(at === undefined ? [] : [at])], {
      cwd: repo,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * each mechanical file of a scope's diff, by the path the review lists it
 * under, with what made it so. `at` is the ref the branch is read at - its
 * head - or undefined for the working tree
 */
export const findMechanical = (
  repo: string,
  { removed, added }: DiffLines,
  moves: Move[],
  at: string | undefined,
): Mechanical => {
  // lines a verbatim move accounts for, edits aside
  const movedLines = new Set<string>();
  for (const move of moves) {
    const editedFrom = new Set(move.residual.flatMap((edit) => edit.removed.map((line) => line.line)));
    const editedTo = new Set(move.residual.flatMap((edit) => edit.added.map((line) => line.line)));
    for (let line = move.from.start; line <= move.from.end; line++) {
      if (!editedFrom.has(line)) movedLines.add(`-${move.from.path}:${line}`);
    }
    for (let line = move.to.start; line <= move.to.end; line++) {
      if (!editedTo.has(line)) movedLines.add(`+${move.to.path}:${line}`);
    }
  }
  const removedImports = importLines(removed);
  const addedImports = importLines(added);

  // the hunks, each its removed and added lines, under the file's row
  // keyed by file as well: a whole untracked file is in no hunk of the diff
  const hunks = new Map<string, { row: string; removed: DiffLine[]; added: DiffLine[] }>();
  for (const [lines, side] of [
    [removed, "removed"],
    [added, "added"],
  ] as const) {
    for (const line of lines) {
      const key = `${line.row}\u0000${line.hunk}`;
      const hunk = hunks.get(key) ?? { row: line.row, removed: [], added: [] };
      hunk[side].push(line);
      hunks.set(key, hunk);
    }
  }

  // why each hunk is mechanical, or false; renames are checked once at the end
  const renames = new Map<string, string>();
  const verdicts = new Map<string, (string | false)[]>();
  for (const hunk of hunks.values()) {
    const said = (line: DiffLine): boolean => line.key !== "";
    const gone = hunk.removed.filter(said);
    const come = hunk.added.filter(said);
    let verdict: string | false = false;
    if ([...gone, ...come].every((line) => removedImports.has(line) || addedImports.has(line))) {
      verdict = "imports";
    } else if (
      gone.every((line) => movedLines.has(`-${line.path}:${line.line}`)) &&
      come.every((line) => movedLines.has(`+${line.path}:${line.line}`))
    ) {
      verdict = "moved";
    } else {
      // the imports a hunk also changes don't stop the rest being mechanical
      const before = tokensOf(gone.filter((line) => !removedImports.has(line)));
      const after = tokensOf(come.filter((line) => !addedImports.has(line)));
      if (before.join(" ") === after.join(" ")) {
        verdict = "reformatted";
      } else if (before.length === after.length) {
        const swaps = before
          .map((token, index) => [token, after[index] ?? ""] as const)
          .filter(([was, now]) => was !== now);
        if (swaps.every(([was, now]) => identifier.test(was) && identifier.test(now))) {
          for (const [was, now] of swaps) {
            renames.set(was, renames.get(was) === undefined || renames.get(was) === now ? now : "\u0000");
          }
          verdict = `rename ${swaps.map(([was, now]) => `${was}→${now}`).join(" ")}`;
        }
      }
    }
    verdicts.set(hunk.row, [...(verdicts.get(hunk.row) ?? []), verdict]);
  }

  // a rename is one when the old name went everywhere, consistently
  const genuine = new Map<string, boolean>();
  for (const [was, now] of renames) {
    genuine.set(was, now !== "\u0000" && !stillUsed(repo, was, at));
  }

  const mechanical: Mechanical = {};
  for (const [row, said] of verdicts) {
    const reasons = new Set<string>();
    let ok = true;
    for (const verdict of said) {
      if (verdict === false) {
        ok = false;
        break;
      }
      if (verdict.startsWith("rename ")) {
        const pairs = verdict.slice("rename ".length).split(" ");
        if (!pairs.every((pair) => genuine.get(pair.split("→")[0] ?? "") === true)) {
          ok = false;
          break;
        }
        for (const pair of pairs) reasons.add(`rename ${pair.replace("→", " → ")}`);
      } else {
        reasons.add(verdict);
      }
    }
    if (ok && reasons.size > 0) {
      mechanical[row] = [...reasons].join("; ");
    }
  }
  return mechanical;
};
