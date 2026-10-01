#!/usr/bin/env node
/* Read the PR comments for every review a page carries, and write them beside
 * it for the page to show.
 *
 *   node prComments.ts --html <review.html> [--repo <dir>] [--watch <seconds>]
 *
 * Each carried review names its head branch, which is enough to find its PR
 * (a stacked review keyed by a PR number says so outright). What comes back -
 * inline review threads, the PR conversation, each review's verdict - is
 * written to `<html dir>/<review id>/github.json`, which the served page picks
 * up through its own poll within a couple of seconds.
 *
 * A review with no PR behind it (a commit, a working tree, a stack layer
 * nobody has pushed) is skipped, quietly: there is nothing on the forge to
 * read.
 *
 * --watch keeps reading, so comments left while the review is open turn up in
 * it. Sixty seconds is plenty: a whole stack costs one api call per PR per
 * round, against a budget of 5000 an hour.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { fetchPrComments, prForBranch } from "./github.ts";
import { type ReviewShell } from "./src/ReviewPayload.ts";

const { values } = parseArgs({
  options: {
    html: { type: "string" },
    repo: { type: "string" },
    watch: { type: "string" },
  },
});

if (values.html === undefined) {
  console.log("prComments.ts --html <review.html> [--repo <dir>] [--watch <seconds>]");
  process.exit(1);
}

const htmlPath = values.html;
const repo = values.repo ?? process.cwd();
const shellPattern = /<script type="application\/json" id="shell">(?<json>[\s\S]*?)<\/script>/;

const readShell = (): ReviewShell => {
  const found = shellPattern.exec(readFileSync(htmlPath, "utf8"));
  if (found?.groups?.json === undefined) {
    throw new Error(`${htmlPath} carries no shell - rebuild it with the current build.ts`);
  }
  return JSON.parse(found.groups.json) as ReviewShell;
};

/** the PR a review is of: its key when that is a number (a stacked PR), else
    whatever PR its head branch has */
const prOf = (review: { key: string; head?: string }): number | undefined => {
  if (/^\d+$/.test(review.key)) {
    return Number(review.key);
  }
  return review.head === undefined ? undefined : prForBranch(repo, review.head);
};

const round = (): void => {
  const shell = readShell();
  const carried = shell.reviews.filter((review) => review.reviewId !== undefined);
  let found = 0;

  for (const review of carried) {
    const pr = prOf(review);
    if (pr === undefined) {
      continue;
    }
    found += 1;
    try {
      const github = fetchPrComments(repo, pr);
      const storeDir = join(dirname(htmlPath), review.reviewId ?? "");
      if (!existsSync(storeDir)) {
        mkdirSync(storeDir, { recursive: true });
      }
      writeFileSync(join(storeDir, "github.json"), `${JSON.stringify(github, null, 2)}\n`, "utf8");
      const open = github.threads.filter((thread) => !thread.resolved).length;
      console.log(
        `#${pr} ${review.label}: ${github.threads.length} thread(s), ${open} unresolved, ` +
          `${github.conversation.length} comment(s), ${github.verdicts.length} review(s)`,
      );
    } catch (error) {
      // one PR failing (a fork, a token without access) must not stop the rest
      console.error(`#${pr} ${review.label}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  if (found === 0) {
    console.error(
      "none of this page's reviews has a pull request behind it - nothing to read from the forge",
    );
  }
};

round();

if (values.watch !== undefined) {
  const seconds = Number(values.watch);
  console.log(`watching for new comments every ${seconds}s - ctrl-c to stop`);
  setInterval(round, seconds * 1_000);
}
