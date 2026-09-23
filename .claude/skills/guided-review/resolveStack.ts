#!/usr/bin/env node
/* Resolve the stack a change belongs to, whichever repo it is in.
 *
 *   node resolveStack.ts 34
 *   node resolveStack.ts my-branch
 *   node resolveStack.ts https://github.com/owner/repo/pull/34
 *   node resolveStack.ts --stack          # the gh stack this checkout is on
 *
 * Two ways in, because a stack does not need a forge to exist:
 *
 * - **From a PR** (the default): a stack is a chain of open PRs where each
 *   one's base branch is the head branch of the one below it. This walks the
 *   chain both ways from the given PR. The walk stops (with a note on stderr)
 *   if a PR has more than one open PR based on its head, since the chain above
 *   that point is ambiguous.
 * - **From `gh stack`** (`--stack`): the chain of branches `gh stack` holds
 *   for this checkout, whether or not any of them has been pushed. Use this
 *   for a stack of local branches - one you are reviewing before submitting,
 *   or that will never be submitted at all. Layers that do have PRs keep their
 *   numbers and links, so a half-submitted stack resolves in one piece.
 *
 * Either way it prints json:
 *
 *   { "current": "<key>", "entries": [ { key, label, number?, title, url, base, head }, … ] }
 *
 * entries are in stack order, the layer nearest the trunk first. `key` is what
 * the page and the stack directory identify a layer by: its PR number, or its
 * branch as a slug when it has no PR. A change in no stack prints a single
 * entry - callers should only pass the file to `--stack` when there are two or
 * more.
 */

import { execFileSync } from "node:child_process";

import { branchKey } from "./reviewAssembly.ts";
import { type StackEntry } from "./reviewAssembly.ts";

/** `gh stack view --json`: the branches of this checkout's stack, bottom
    first, each with its PR where one has been pushed */
type GhStack = {
  trunk: string;
  currentBranch: string;
  branches: {
    name: string;
    isCurrent?: boolean;
    pr?: { number?: number; title?: string; url?: string };
  }[];
};

type OpenPr = {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
};

const [target] = process.argv.slice(2);
if (target === undefined) {
  console.error("usage: resolveStack.ts <number|branch|url>|--stack");
  process.exit(1);
}

const gh = (...args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 });

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 });

const printStack = (current: string, entries: StackEntry[], what: string): void => {
  console.log(JSON.stringify({ current, entries }, null, 2));
  console.error(
    entries.length > 1 ?
      `${what} sits in a stack of ${entries.length}`
    : `${what} is not part of a stack`,
  );
};

/** the layers `gh stack` holds for this checkout, pushed or not */
const fromGhStack = (): void => {
  const stack = JSON.parse(gh("stack", "view", "--json")) as GhStack;
  const entries: StackEntry[] = stack.branches.map((branch, index) => {
    const number = branch.pr?.number;
    const below = stack.branches[index - 1];
    return {
      key: number === undefined ? branchKey(branch.name) : String(number),
      label: number === undefined ? branch.name : `#${number}`,
      ...(number === undefined ? {} : { number }),
      // a layer nobody has pushed has no PR title; its newest commit says
      // what it is better than its branch name alone
      title:
        branch.pr?.title ??
        git("log", "-1", "--format=%s", branch.name).trim() ??
        branch.name,
      url: branch.pr?.url ?? "",
      base: below === undefined ? stack.trunk : below.name,
      head: branch.name,
    };
  });
  const current =
    entries.find((entry) => entry.head === stack.currentBranch)?.key ?? entries.at(-1)?.key ?? "";
  const pushed = entries.filter((entry) => entry.number !== undefined).length;
  printStack(
    current,
    entries,
    `${stack.currentBranch} (${pushed === 0 ? "no layer pushed yet" : `${pushed}/${entries.length} pushed`})`,
  );
};

if (target === "--stack") {
  fromGhStack();
  process.exit(0);
}

const prFields = "number,title,url,baseRefName,headRefName";

const anchor = JSON.parse(gh("pr", "view", target, "--json", prFields)) as OpenPr;
const openPrs = JSON.parse(
  gh("pr", "list", "--state", "open", "--json", prFields, "--limit", "200"),
) as OpenPr[];

const byNumber = new Map(openPrs.map((pr) => [pr.number, pr]));
byNumber.set(anchor.number, anchor);

const prWithHead = (ref: string): OpenPr | undefined =>
  openPrs.find((pr) => pr.headRefName === ref && pr.number !== anchor.number);

const prsBasedOn = (ref: string): OpenPr[] =>
  [...byNumber.values()].filter((pr) => pr.baseRefName === ref);

/** the chain below the anchor: each PR's base is the head of the one before */
const below: OpenPr[] = [];
const seen = new Set([anchor.number]);
let walkDown: OpenPr | undefined = prWithHead(anchor.baseRefName);
while (walkDown !== undefined && !seen.has(walkDown.number)) {
  below.unshift(walkDown);
  seen.add(walkDown.number);
  walkDown = prWithHead(walkDown.baseRefName);
}

/** the chain above: PRs based on the current head, linearly */
const above: OpenPr[] = [];
let walkUp: OpenPr = anchor;
for (;;) {
  const children = prsBasedOn(walkUp.headRefName).filter((pr) => !seen.has(pr.number));
  if (children.length === 0) {
    break;
  }
  if (children.length > 1) {
    console.error(
      `stack forks above #${walkUp.number}: ${children.map((pr) => `#${pr.number}`).join(", ")} all base on ${walkUp.headRefName} - stopping there`,
    );
    break;
  }
  const [child] = children;
  if (child === undefined) {
    break;
  }
  above.push(child);
  seen.add(child.number);
  walkUp = child;
}

const entries: StackEntry[] = [...below, anchor, ...above].map(
  ({ number, title, url, baseRefName, headRefName }) => ({
    key: String(number),
    label: `#${number}`,
    number,
    title,
    url,
    base: baseRefName,
    head: headRefName,
  }),
);

printStack(String(anchor.number), entries, `#${anchor.number}`);
