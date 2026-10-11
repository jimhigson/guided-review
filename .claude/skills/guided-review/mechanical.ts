#!/usr/bin/env node
/* Which files a change touched only mechanically - imports, reformatting, a
 * rename, code moved verbatim - for the agent to offer the reader to tick as
 * read before reading starts. How a file is judged is in mechanicalChanges.ts;
 * build.ts runs the same, marks those files in the page, and ticks them when
 * the groups json's meta says `"preTickMechanical": true`.
 *
 *   node mechanical.ts worktree
 *   node mechanical.ts commit <sha>
 *   node mechanical.ts pr <base> <head>          # three-dot, as changedFiles.sh
 *   ... [--repo <dir>] [--json]
 */

import { parseArgs } from "node:util";

import { findMechanical } from "./mechanicalChanges.ts";
import { collectDiffLines, findMoves, type MoveScope } from "./moveDetection.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string", default: "." },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
const [mode, ...refs] = positionals;
const valid = mode === "worktree" || (mode === "commit" && refs.length === 1) || (mode === "pr" && refs.length === 2);
if (values.help || !valid) {
  console.log("mechanical.ts worktree | commit <sha> | pr <base> <head>  [--repo <dir>] [--json]");
  process.exit(values.help ? 0 : 1);
}

const scope: MoveScope =
  mode === "commit" ? { mode, ref: refs[0] ?? "" }
  : mode === "pr" ? { mode, base: refs[0] ?? "", head: refs[1] ?? "" }
  : { mode: "worktree" };
const lines = collectDiffLines(values.repo, scope);
const at = scope.mode === "commit" ? scope.ref : scope.mode === "pr" ? scope.head : undefined;
const mechanical = findMechanical(values.repo, lines, findMoves(lines.removed, lines.added), at);

if (values.json) {
  console.log(JSON.stringify(mechanical, null, 2));
} else {
  const files = new Set([...lines.removed, ...lines.added].map((line) => line.row));
  const entries = Object.entries(mechanical).sort(([a], [b]) => a.localeCompare(b));
  console.log(`${entries.length} of ${files.size} changed files are purely mechanical`);
  const byKind = new Map<string, number>();
  for (const [, reason] of entries) {
    for (const part of reason.split("; ")) {
      byKind.set(part, (byKind.get(part) ?? 0) + 1);
    }
  }
  for (const [kind, count] of [...byKind].sort(([, a], [, b]) => b - a)) {
    console.log(`  ${count}  ${kind}`);
  }
  console.log("");
  for (const [path, reason] of entries) {
    console.log(`${path}  — ${reason}`);
  }
}
