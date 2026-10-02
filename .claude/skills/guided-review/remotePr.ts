#!/usr/bin/env node
/* Resolve a pull request on GitHub to refs that can be diffed here, whether or
 * not this machine has the repo.
 *
 *   node remotePr.ts https://github.com/owner/name/pull/34
 *   node remotePr.ts owner/name#34
 *   node remotePr.ts 34                 # only inside a checkout of that repo
 *
 * Prints json: { number, title, url, base, head, repo } - the same shape
 * resolvePr.sh prints, plus the repo to pass every later command as `--repo`.
 *
 * Where to read the code from, in order:
 *
 * - **the current checkout**, when it is a clone of that repo. The PR's refs
 *   are fetched into it, as resolvePr.sh does: no second copy of a repo you
 *   already have, and the review can be served from the branch if you have it
 *   checked out.
 * - **a cache clone**, otherwise - bare (no working tree, nothing to check
 *   out) and blobless, so git fetches only the file versions the review
 *   actually opens. A repo whose history is hundreds of megabytes checked out
 *   costs a few hundred kilobytes this way. It is kept under the cache
 *   directory and reused, so the second review of the same repo is a fetch
 *   rather than a clone.
 *
 * Reviewing someone else's PR therefore needs nothing checked out, and leaves
 * whatever you are working on alone.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { cache: { type: "string" } },
  allowPositionals: true,
});

const [target] = positionals;
if (target === undefined) {
  console.log("remotePr.ts <pr url|owner/name#number|number> [--cache <dir>]");
  process.exit(1);
}

const run = (cwd: string, command: string, ...args: string[]): string =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const quiet = (cwd: string, command: string, ...args: string[]): string | undefined => {
  try {
    return run(cwd, command, ...args);
  } catch {
    return undefined;
  }
};

/** owner/name and the number, from any of the ways a PR gets named */
const nameTarget = (): { slug?: string; number?: number } => {
  const url = /github\.com\/(?<owner>[^/]+)\/(?<name>[^/]+)\/pull\/(?<number>\d+)/.exec(target);
  if (url?.groups !== undefined) {
    return {
      slug: `${url.groups.owner}/${url.groups.name}`,
      number: Number(url.groups.number),
    };
  }
  const hashed = /^(?<owner>[^/\s]+)\/(?<name>[^#\s]+)#(?<number>\d+)$/.exec(target);
  if (hashed?.groups !== undefined) {
    return {
      slug: `${hashed.groups.owner}/${hashed.groups.name}`,
      number: Number(hashed.groups.number),
    };
  }
  return /^\d+$/.test(target) ? { number: Number(target) } : {};
};

const { slug, number: numbered } = nameTarget();

/** the clone to read from: this checkout when it is the right repo, else a
    bare blobless one in the cache */
const repoToUse = (): string => {
  const here = quiet(process.cwd(), "git", "rev-parse", "--show-toplevel")?.trim();
  const hereSlug =
    here === undefined ? undefined : (
      quiet(here, "gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")?.trim()
    );
  if (here !== undefined && (slug === undefined || hereSlug === slug)) {
    return here;
  }
  if (slug === undefined) {
    throw new Error(
      `${target} names no repo, and this directory is not a checkout of one - give the pr's url`,
    );
  }

  const cacheDir =
    values.cache ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "guided-review");
  mkdirSync(cacheDir, { recursive: true });
  const clone = join(cacheDir, `${slug.replace("/", "-")}.git`);
  if (existsSync(clone)) {
    console.error(`reusing the cached clone of ${slug}`);
    return clone;
  }
  console.error(`cloning ${slug} (bare and blobless - no working tree, no file content yet)`);
  // through gh, so a private repo works on whatever auth gh already has
  run(cacheDir, "gh", "repo", "clone", slug, clone, "--", "--bare", "--filter=blob:none");
  return clone;
};

const repo = repoToUse();

type Pr = { number: number; title: string; url: string; baseRefName: string; headRefName: string };

const pr = JSON.parse(
  run(
    repo,
    "gh",
    "pr",
    "view",
    numbered === undefined ? target : String(numbered),
    "--json",
    "number,title,url,baseRefName,headRefName",
  ),
) as Pr;

// the base branch, then the PR's head from refs/pull - which is how a PR from
// a fork reads exactly like one from a branch on the origin
quiet(repo, "git", "fetch", "--quiet", "origin", `${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`) ??
  run(repo, "git", "fetch", "--quiet", "origin", pr.baseRefName);
run(
  repo,
  "git",
  "fetch",
  "--quiet",
  "--force",
  "origin",
  `refs/pull/${pr.number}/head:refs/review/pr${pr.number}`,
);

console.log(
  JSON.stringify(
    {
      ...pr,
      base: `origin/${pr.baseRefName}`,
      head: `refs/review/pr${pr.number}`,
      repo,
    },
    null,
    2,
  ),
);
