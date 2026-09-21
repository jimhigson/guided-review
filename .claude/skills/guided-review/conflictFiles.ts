#!/usr/bin/env node
/* changedFiles.sh's conflict mode: `STATUS<TAB>PATH` for every file worth
 * reading in a conflict resolution, conflicted files first. Which of the two
 * kinds each is goes to stderr, for whoever is authoring the groups json.
 *
 *   node conflictFiles.ts [--ref <merge commit>]
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { conflictFiles, resolveConflict } from "./conflict.ts";

const { values } = parseArgs({ options: { ref: { type: "string" } } });
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const refs = resolveConflict(repo, values.ref);
const files = conflictFiles(repo, refs);

for (const { status, path } of files) {
  console.log(`${status}\t${path}`);
}
console.error(
  `${refs.operation}: ${refs.info.current.label} ← ${refs.info.incoming.label}\n` +
    files.map(({ kind, path }) => `  ${kind === "conflicted" ? "conflicted" : "edited    "}  ${path}`).join("\n"),
);
