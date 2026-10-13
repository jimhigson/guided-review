#!/usr/bin/env node
/* Resolving a conflict that stopped the review page committing held edits or
 * restacking - for the agent the page asked to.
 *
 *   node restack.ts status   --html <review.html> --repo <dir>
 *   node restack.ts resolve  --html <review.html> --repo <dir> [--dir <worktree>]
 *   node restack.ts resolved --html <review.html> --repo <dir> [--dir <worktree>]
 *
 * status    what is held where, which PRs are stale, and the last conflict
 * resolve   sets the conflict up in a scratch worktree: the commit it was being
 *           replayed onto checked out, the commit's change merged in, and each
 *           file that wouldn't merge left with labelled conflict markers.
 *           Prints the worktree and the files to fix
 * resolved  records the worktree's content as the resolution of exactly that
 *           commit onto exactly that parent, and removes the worktree. The
 *           next attempt - the page's button, pressed again - uses it
 *
 * Nothing here moves a branch: the page does that, all at once, once the
 * whole replay is clean.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { type Conflict, heldOn, recordResolution, setUpResolution, staleAbove } from "./stackEdit.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    html: { type: "string" },
    repo: { type: "string" },
    dir: { type: "string" },
  },
});
const [command] = positionals;
if (values.html === undefined || values.repo === undefined || !["status", "resolve", "resolved"].includes(command ?? "")) {
  console.log("restack.ts status|resolve|resolved --html <review.html> --repo <dir> [--dir <worktree>]");
  process.exit(1);
}
const repo = resolve(values.repo);
const conflictFile = join(dirname(resolve(values.html)), "restack-conflict.json");
const worktree = values.dir ?? join(tmpdir(), "guided-review-resolve");

/** the stack's branches, trunk end first, from the page's shell */
const layers = (): string[] => {
  const shell = /<script type="application\/json" id="shell">([\s\S]*?)<\/script>/.exec(readFileSync(values.html ?? "", "utf8"));
  const parsed = JSON.parse(shell?.[1] ?? "{}") as { reviews?: { head?: string; aggregate?: boolean }[] };
  return (parsed.reviews ?? []).filter((review) => review.aggregate !== true && review.head !== undefined).map((review) => review.head ?? "");
};

const lastConflict = (): (Conflict & { doing: string }) | undefined =>
  existsSync(conflictFile) ? (JSON.parse(readFileSync(conflictFile, "utf8")) as Conflict & { doing: string }) : undefined;

if (command === "status") {
  for (const branch of layers()) {
    const held = heldOn(repo, branch);
    console.log(`${branch}${held === undefined ? "" : `  edits held after ${held.anchor.slice(0, 9)}`}`);
  }
  const stale = staleAbove(repo, layers());
  console.log(stale.length === 0 ? "nothing to restack" : `to restack: ${stale.join(", ")}`);
  const conflict = lastConflict();
  if (conflict !== undefined) {
    console.log(
      `last conflict (${conflict.doing}): ${conflict.commit.slice(0, 9)} "${conflict.subject}" onto ${conflict.onto.slice(0, 9)} in ${conflict.files.join(", ")}`,
    );
  }
} else {
  const conflict = lastConflict();
  if (conflict === undefined) {
    console.error(`no conflict recorded beside ${values.html}`);
    process.exit(1);
  }
  if (command === "resolve") {
    const files = setUpResolution(repo, conflict, worktree);
    console.log(`${worktree}: ${conflict.commit.slice(0, 9)} "${conflict.subject}" merged onto ${conflict.onto.slice(0, 9)}`);
    console.log(`resolve the conflict markers in: ${files.join(", ")}`);
    console.log(`then: node ${join(dirname(new URL(import.meta.url).pathname), "restack.ts")} resolved --html ${values.html} --repo ${repo} --dir ${worktree}`);
  } else {
    const resolution = recordResolution(repo, worktree, conflict);
    console.log(`recorded ${resolution.slice(0, 9)} as the resolution - ${conflict.doing === "restacking" ? "Rebase upstack" : "committing the held edits"} can be pressed again`);
  }
}
