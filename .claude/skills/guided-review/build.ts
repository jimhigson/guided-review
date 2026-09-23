#!/usr/bin/env node
/* Build the guided-review page from an authored groups json.
 *
 * The only part of a guided review that needs judgement is the grouping and the
 * per-file notes; everything else - collecting diffs, capturing image versions,
 * stripping headers, counting lines, computing github anchors, inlining the
 * ui - is mechanical and happens here (via reviewAssembly.ts, which
 * buildStack.ts shares to put a whole PR stack in one page).
 *
 *   node build.ts --groups review.json --out review.html --mode worktree
 *   node build.ts --groups review.json --out review.html --mode commit --ref <sha> \
 *                 --github https://github.com/owner/repo/commit/<sha>
 *   node build.ts --groups review.json --out review.html --mode pr \
 *                 --base origin/main --head origin/my-branch \
 *                 --github https://github.com/owner/repo/pull/12/files
 *   node build.ts --groups review.json --out review.html --mode conflict
 *                 (a paused merge/rebase/cherry-pick/revert; --ref <merge> for a finished merge)
 *
 * The groups json is `{"meta": {...}, "groups": [{title, blurb, items: [{path,
 * status, note}]}]}`. meta takes title, headerTitle, eyebrow, lede, facts (a
 * list of html strings, appended after the file and line counts) and footer;
 * lede and footer may contain html.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildPage } from "./buildPage.ts";
import { resolveConflict } from "./conflict.ts";
import {
  type AuthoredGroups,
  branchKey,
  collectReview,
  finishCss,
  git,
  jsonBlock,
  page,
  readResolvedStack,
  reviewBlockId,
  type ReviewOptions,
  shortRef,
} from "./reviewAssembly.ts";
import { type ReviewShell, type ShellReview } from "./src/ReviewPayload.ts";

type Options = ReviewOptions & {
  groups: string;
  out: string;
  repo?: string;
  stack?: string;
};

const usage = (): never => {
  console.log(
    [
      "build.ts --groups <authored.json> --out <review.html> --mode worktree|commit|pr|conflict",
      "  --ref <sha>                commit mode: what to show; conflict mode: a finished merge commit",
      "  --base <ref> --head <ref>  pr mode: what to diff",
      "  --pr <number>              per-file links point at its Files changed tab",
      "  --stack <json>             resolveStack.ts output; the bar shows the stack when 2+ PRs",
      "  --github <url>|none        base url for those links (derived from origin otherwise)",
      "  --repo <dir>               repo root (default: git toplevel)",
      "  --id <name>                names the directory a served review keeps ticks and notes in",
      "  --max-side-lines <n>       longer files aren't embedded, their row says so (default 2000)",
      "  --max-images <n>           image files embedded with their versions (default 100)",
    ].join("\n"),
  );
  process.exit(1);
};

const parseOptions = (): Options => {
  const { values } = parseArgs({
    options: {
      groups: { type: "string" },
      out: { type: "string" },
      mode: { type: "string" },
      ref: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      pr: { type: "string" },
      github: { type: "string" },
      repo: { type: "string" },
      id: { type: "string" },
      stack: { type: "string" },
      "max-side-lines": { type: "string", default: "2000" },
      "max-images": { type: "string", default: "100" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help === true) {
    usage();
  }
  const { groups, out, mode } = values;
  if (groups === undefined || out === undefined || mode === undefined) {
    throw new Error("--groups, --out and --mode are all required");
  }
  if (mode !== "worktree" && mode !== "commit" && mode !== "pr" && mode !== "conflict") {
    throw new Error(`--mode must be worktree, commit, pr or conflict, not ${mode}`);
  }
  if (mode === "commit" && values.ref === undefined) {
    throw new Error("commit mode needs --ref");
  }
  if (mode === "pr" && (values.base === undefined || values.head === undefined)) {
    throw new Error("pr mode needs --base and --head");
  }

  return {
    groups,
    out,
    mode,
    ref: values.ref,
    base: values.base,
    head: values.head,
    pr: values.pr,
    github: values.github,
    repo: values.repo,
    id: values.id,
    stack: values.stack,
    maxSideLines: Number(values["max-side-lines"]),
    maxImages: Number(values["max-images"]),
  };
};

/**
 * every review the page should know about: this one (carried), and - when a
 * stack file names 2+ PRs - its siblings, carried or not
 */
const shellFor = (
  options: Options,
  collectedId: string,
  title: string,
  baseSha: string,
): ReviewShell => {
  const head = options.mode === "pr" && options.head !== undefined ? shortRef(options.head) : undefined;
  const key = options.pr ?? (head === undefined ? "0" : branchKey(head));
  const own: ShellReview = {
    key,
    label: options.pr === undefined ? (head ?? "review") : `#${options.pr}`,
    title,
    url: "",
    block: reviewBlockId(key),
    reviewId: collectedId,
    baseSha,
    ...(head === undefined ? {} : { head }),
  };

  if (options.stack === undefined) {
    return { reviews: [own], current: key };
  }
  const stack = readResolvedStack(options.stack);
  if (stack.entries.length < 2) {
    return { reviews: [own], current: key };
  }
  // which layer this build *is*: its number where it has one, else its branch
  const mine = stack.entries.find((entry) =>
    options.pr === undefined ? entry.head === head : entry.number === Number(options.pr),
  );
  return {
    current: mine?.key ?? key,
    reviews: stack.entries.map((entry) =>
      entry.key === mine?.key ?
        { ...own, key: entry.key, label: entry.label, title: entry.title, url: entry.url, head: entry.head, block: reviewBlockId(entry.key) }
      : { key: entry.key, label: entry.label, title: entry.title, url: entry.url, head: entry.head },
    ),
  };
};

const main = async (): Promise<void> => {
  const options = parseOptions();
  const repo = options.repo ?? git(process.cwd(), "rev-parse", "--show-toplevel").trim();
  if (options.mode === "conflict") {
    options.conflict = resolveConflict(repo, options.ref);
  }

  const authored = JSON.parse(readFileSync(options.groups, "utf8")) as AuthoredGroups;
  const collected = collectReview(
    repo,
    options,
    authored,
    `img-${options.pr ?? "0"}`,
  );
  const { payload, imageBlocks, forge, empty, imageBytes, imagesOmitted, baseSha } = collected;

  const shell = shellFor(options, payload.id, payload.meta.title, baseSha);
  const currentReview = shell.reviews.find((review) => review.key === shell.current);
  const { script, css } = await buildPage();
  const html = page(
    shell,
    [jsonBlock(currentReview?.block ?? reviewBlockId(shell.current), payload), ...imageBlocks],
    script,
    finishCss(css),
  );

  writeFileSync(options.out, html, "utf8");

  const totals = Object.values(payload.stats).reduce(
    ([added, removed], [fileAdded, fileRemoved]) => [added + fileAdded, removed + fileRemoved],
    [0, 0],
  );
  console.log(`${Object.keys(payload.stats).length} files  +${totals[0]} −${totals[1]}`);
  if (imageBlocks.length > 0 || imagesOmitted > 0) {
    console.log(
      `images  ${imageBlocks.length} embedded (${Math.round(imageBytes / 1_024)} KiB)` +
        (imagesOmitted > 0 ? `, ${imagesOmitted} left out by --max-images` : ""),
    );
  }
  console.log(`wrote ${options.out}  (${Math.round(Buffer.byteLength(html) / 1_024)} KiB)`);
  console.log(`links   ${forge ?? "none (nothing to link to)"}`);
  if (payload.conflict !== undefined) {
    const kinds = Object.values(payload.conflict.files);
    console.log(
      `conflict ${payload.conflict.operation}: ${payload.conflict.current.label} ← ${payload.conflict.incoming.label}` +
        `  (${kinds.filter((kind) => kind === "conflicted").length} conflicted, ${kinds.filter((kind) => kind === "edited").length} edited beyond git's merge)`,
    );
  }
  if (shell.reviews.length > 1) {
    console.log(
      `stack   ${shell.reviews.map((review) => (review.key === shell.current ? `[${review.label}]` : review.label)).join(" → ")}`,
    );
  }
  console.log(`id      ${payload.id}  (ticks and notes live in a directory of this name)`);
  if (empty.length > 0) {
    console.error(`warning: no diff found for ${empty.length} file(s):`);
    for (const path of empty) {
      console.error(`  ${path}`);
    }
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
