#!/usr/bin/env node
/* Making an edit a reviewer asked for in a note, where their own edit from
 * that row would have gone.
 *
 *   node held.ts open --html <review.html> --repo <dir> --notes <store>/notes.json \
 *                     --path <file> --line <n> [--dir <scratch>]
 *   node held.ts save --dir <scratch>
 *
 * A note remembers what the reviewer was reading when they wrote it: a commit
 * of the PR, the PR's held edits, or the PR as a whole. From there, a
 * reviewer's own edit goes either
 *
 *   - to disk: the PR the served checkout has checked out, read whole (or its
 *     uncommitted/working changes). `open` says so, and you edit the files in
 *     the checkout as usual; or
 *   - into the PR's held edits: every other PR, and any commit of any PR -
 *     against the commit they were reading, or the PR's last commit when
 *     reading it whole. `open` sets up a scratch worktree holding the PR as
 *     of that commit with what is already held applied; edit the files there
 *     with your usual tools, then `save` puts every change you made into the
 *     held edits, exactly as a save from the page does. The reviewer sees it
 *     on the commit bar within seconds, to commit or amend when they choose.
 *
 * Never check a branch out to make such an edit yourself: what is held is
 * the reviewer's to commit, and a checkout would move it out from under them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import { editPlaceOf, readingOf, readShell, reviewOfNotes } from "./editPlace.ts";
import { fileAt, heldOn, refValue, saveToHold } from "./stackEdit.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    html: { type: "string" },
    repo: { type: "string" },
    notes: { type: "string" },
    path: { type: "string" },
    line: { type: "string" },
    dir: { type: "string" },
  },
});
const [command] = positionals;

const usage = (): never => {
  console.log(
    "held.ts open --html <review.html> --repo <dir> --notes <store>/notes.json --path <file> --line <n> [--dir <scratch>]\n" +
      "held.ts save --dir <scratch>",
  );
  process.exit(1);
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** what a scratch worktree is for, kept in its own git dir */
type Opened = { repo: string; branch: string; anchor: string; from: string };

const recordFile = (dir: string): string => join(resolve(dir, git(dir, "rev-parse", "--git-dir").trim()), "guided-review-held.json");

const open = (): void => {
  const { html, repo: repoArg, notes, path, line } = values;
  if (html === undefined || repoArg === undefined || notes === undefined || path === undefined || line === undefined) {
    usage();
    return;
  }
  const repo = resolve(repoArg);
  const shell = readShell(html);
  const review = reviewOfNotes(shell, notes, html);
  const reading = readingOf(notes, path, Number(line));
  const place = editPlaceOf(repo, shell, review, reading);
  if (place.kind === "disk") {
    console.log(`this row saves to disk: edit ${join(repo, path)} in the checkout, as usual - the page follows it`);
    return;
  }
  const { branch } = place;
  const held = heldOn(repo, branch);
  const anchor =
    reading?.startsWith("held:") === true ? held?.anchor
    : place.reading !== undefined ? place.reading
    : refValue(repo, `refs/heads/${branch}`);
  if (anchor === undefined) {
    throw new Error(`nothing to edit: ${reading?.startsWith("held:") === true ? `no edits are held on ${branch} any more` : `${branch} is not a branch here`}`);
  }
  if (held !== undefined && held.anchor !== anchor) {
    throw new Error(
      `edits are already held on ${branch} after ${held.anchor.slice(0, 9)}, not ${anchor.slice(0, 9)} - ` +
        "ask the reviewer to commit or amend them first (one place per PR)",
    );
  }
  const from = held?.commit ?? anchor;
  const dir = resolve(values.dir ?? join(tmpdir(), `guided-review-held-${branch.replaceAll("/", "-")}`));
  if (existsSync(dir)) {
    throw new Error(`${dir} already exists - save or remove it first, or pass another --dir`);
  }
  git(repo, "worktree", "add", "--detach", dir, from);
  const opened: Opened = { repo, branch, anchor, from };
  writeFileSync(recordFile(dir), JSON.stringify(opened, null, 2), "utf8");
  console.log(
    `${dir}: ${branch} as of ${anchor.slice(0, 9)}${held === undefined ? "" : ", with what is already held"}.\n` +
      `edit ${join(dir, path)} (and anything else the note asks for) there, then:\n` +
      `  node ${join(dirname(new URL(import.meta.url).pathname), "held.ts")} save --dir ${dir}`,
  );
};

const save = (): void => {
  const { dir } = values;
  if (dir === undefined) {
    usage();
    return;
  }
  const opened = JSON.parse(readFileSync(recordFile(dir), "utf8")) as Opened;
  const changed = git(dir, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter((entry) => entry !== "")
    .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
  const deleted = changed.filter((entry) => entry.status.includes("D"));
  if (deleted.length > 0) {
    throw new Error(`held edits can't delete files yet: ${deleted.map((entry) => entry.path).join(", ")} - put them back, or say so in the thread`);
  }
  for (const { path } of changed) {
    saveToHold(
      opened.repo,
      opened.branch,
      opened.anchor,
      path,
      readFileSync(join(dir, path), "utf8"),
      // what it was when the worktree was made: a save the reviewer made to
      // the same file since is refused, not written over
      sha256(fileAt(opened.repo, opened.from, path)),
    );
  }
  git(opened.repo, "worktree", "remove", "--force", resolve(dir));
  console.log(
    changed.length === 0 ?
      "nothing changed - nothing held"
    : `held ${changed.length} file(s) on ${opened.branch} after ${opened.anchor.slice(0, 9)}: ${changed.map((entry) => entry.path).join(", ")} - the reviewer sees them on the commit bar now; say so in the thread, naming each with reply.ts --edited`,
  );
};

if (command === "open") {
  open();
} else if (command === "save") {
  save();
} else {
  usage();
}
