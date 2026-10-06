#!/usr/bin/env node
/* Find code a change moved rather than wrote: blocks of removed lines that
 * reappear as added lines, in another file or elsewhere in the same one, so
 * the notes can say "extracted, verbatim" instead of the reader re-reading
 * hundreds of lines git shows as all new. How the matching works is in
 * moveDetection.ts; build.ts runs the same detection to mark moved lines in
 * the page itself.
 *
 *   node moves.ts worktree
 *   node moves.ts commit <sha>
 *   node moves.ts pr <base> <head>          # three-dot, as changedFiles.sh
 *   ... [--repo <dir>] [--json] [--min-chars 24] [--min-words 3] [--min-chars-common 120] [--max-gap 4]
 */

import { parseArgs } from "node:util";

import {
  collectDiffLines,
  defaultThresholds,
  type DiffLine,
  type FileMoves,
  findMoves,
  type Move,
  type MoveScope,
  perFile,
} from "./moveDetection.ts";

const percent = (part: number, whole: number): string =>
  `${whole === 0 ? 0 : Math.round((100 * part) / whole)}%`;

const report = (moves: Move[], files: FileMoves[], removedTotal: number, addedTotal: number): string => {
  if (moves.length === 0) {
    return "no moved code found";
  }
  const movedLines = moves.reduce((sum, move) => sum + move.lines, 0);
  const out: string[] = [
    `${moves.length} moved block(s), ${movedLines} lines - ` +
      `${percent(movedLines, removedTotal)} of what was removed, ` +
      `${percent(movedLines, addedTotal)} of what was added`,
    "",
  ];
  const bySource = [...moves].sort(
    (a, b) => a.from.path.localeCompare(b.from.path) || a.from.start - b.from.start,
  );
  for (const move of bySource) {
    const where = move.from.path === move.to.path ? "  (within the file)" : "";
    const indent = move.indent === 0 ? "" : `, reindented ${move.indent > 0 ? "+" : ""}${move.indent}`;
    const verbatim =
      move.residual.length === 0 ? ", verbatim" : `, ${move.residual.length} edit(s) on the way`;
    out.push(`${move.from.path}:${move.from.start}-${move.from.end}`);
    out.push(
      `  → ${move.to.path}:${move.to.start}-${move.to.end}${where}  ` +
        `(${move.lines} lines${indent}${verbatim})`,
    );
    for (const edit of move.residual) {
      for (const line of edit.removed) out.push(`      - ${line.line}: ${line.text.trim()}`);
      for (const line of edit.added) out.push(`      + ${line.line}: ${line.text.trim()}`);
      out.push("");
    }
  }
  out.push("", "per file (non-blank lines):");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = [
      file.removed > 0 ?
        `removed ${file.removed}, moved out ${file.movedOut} (${percent(file.movedOut, file.removed)})`
      : "",
      file.added > 0 ?
        `added ${file.added}, moved in ${file.movedIn} (${percent(file.movedIn, file.added)})`
      : "",
    ].filter((part) => part !== "");
    out.push(`  ${file.path}: ${parts.join("; ")}`);
    // what else a mostly-moved file gained is what its note should name
    if (file.movedIn * 2 >= file.added && file.added > 0) {
      if (file.unmatched.length === 0) {
        out.push("      nothing else new but imports");
      } else {
        out.push(`      also new, ${file.unmatched.length} line(s) besides imports:`);
        for (const line of file.unmatched.slice(0, 8)) {
          out.push(`        ${line.line}: ${line.text.trim()}`);
        }
        if (file.unmatched.length > 8) out.push("        …");
      }
    }
  }
  return out.join("\n");
};

const main = (): void => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "." },
      json: { type: "boolean", default: false },
      "min-chars": { type: "string", default: String(defaultThresholds.minChars) },
      "min-words": { type: "string", default: String(defaultThresholds.minWords) },
      "min-chars-common": { type: "string", default: String(defaultThresholds.minCharsCommon) },
      "max-gap": { type: "string", default: String(defaultThresholds.maxGap) },
      help: { type: "boolean", default: false },
    },
  });
  const [mode, ...refs] = positionals;
  const valid =
    mode === "worktree" || (mode === "commit" && refs.length === 1) || (mode === "pr" && refs.length === 2);
  if (values.help || !valid) {
    console.log(
      "moves.ts worktree | commit <sha> | pr <base> <head>\n" +
        "  [--repo <dir>] [--json] [--min-chars 24] [--min-words 3] [--min-chars-common 120] [--max-gap 4]",
    );
    process.exit(values.help ? 0 : 1);
  }

  const scope: MoveScope =
    mode === "commit" ? { mode, ref: refs[0] ?? "" }
    : mode === "pr" ? { mode, base: refs[0] ?? "", head: refs[1] ?? "" }
    : { mode: "worktree" };
  const { removed, added } = collectDiffLines(values.repo, scope);
  const moves = findMoves(removed, added, {
    minChars: Number(values["min-chars"]),
    minWords: Number(values["min-words"]),
    minCharsCommon: Number(values["min-chars-common"]),
    maxGap: Number(values["max-gap"]),
  });
  const files = perFile(removed, added, moves);
  if (values.json) {
    console.log(JSON.stringify({ moves, files }, null, 2));
  } else {
    const count = (lines: DiffLine[]): number => lines.filter((line) => line.weight > 0).length;
    console.log(report(moves, files, count(removed), count(added)));
  }
};

main();
