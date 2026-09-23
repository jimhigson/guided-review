#!/usr/bin/env node
/* Build ONE page holding the guided reviews of a whole PR stack.
 *
 *   node buildStack.ts --dir <stackDir> --out <review.html> [--current <pr>]
 *                      [--repo <dir>]
 *                      [--max-diff-lines <n>] [--max-side-lines <n>] [--max-images <n>]
 *
 * The stack directory is the coordination point between however many agents
 * contribute:
 *
 *   <stackDir>/stack.json              resolveStack.ts output - the chain
 *   <stackDir>/<key>.groups.json       that layer's authored groups (one author each)
 *   <stackDir>/<key>.instructions.md   optional: a request for another agent to
 *                                      write the groups json above
 *
 * <key> is the layer's PR number, or - for a layer that is only local, with no
 * PR pushed for it - its branch name as a slug. resolveStack.ts prints the key
 * of every layer, so read it from stack.json rather than guessing.
 *
 * Every layer with a groups json is collected into the page; layers without
 * one appear in the stack bar as not-yet-reviewed (marked as awaiting
 * contribution when an instructions file exists). Contributing is: write your
 * layer's groups json into the directory and re-run this build - the serving
 * process picks up the overwritten html without restarting.
 *
 * A layer with a PR is fetched from refs/pull/<n>/head (matching
 * resolvePr.sh); a local-only layer is read from its branch in this checkout,
 * which is the only copy there is. Either way each layer is diffed against the
 * layer below it - the range GitHub shows for a stacked PR, and the same range
 * for a stack that hasn't been pushed anywhere.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildPage } from "./buildPage.ts";
import {
  type AuthoredGroups,
  collectReview,
  finishCss,
  git,
  jsonBlock,
  page,
  readResolvedStack,
  reviewBlockId,
  type StackEntry,
} from "./reviewAssembly.ts";
import {
  type ReviewGroup,
  type ReviewItem,
  type ReviewShell,
  type ShellReview,
} from "./src/ReviewPayload.ts";

/** one layer's authored review, kept for the every-layer-at-once one */
type AuthoredLayer = { entry: StackEntry; authored: AuthoredGroups };

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * what the whole-stack review leads with: each PR of the stack saying what it
 * does, in its own author's words (its title and lede). A reader arriving at
 * the stack wants to know what is in it - not how this page was assembled,
 * which is a footnote at most.
 */
const stackSummary = (layers: AuthoredLayer[]): string =>
  layers
    .map(({ entry, authored }, index) => {
      const title = escapeText(authored.meta?.title ?? entry.label);
      const lede = authored.meta?.lede ?? "";
      return (
        `<span class="pr-summary">` +
        `<span class="layer-chip" title="${escapeText(entry.label)}">PR ${index + 1}/${layers.length}</span> ` +
        `<strong>${title}</strong>` +
        (lede === "" ? "" : ` <span class="pr-summary-text">${lede}</span>`) +
        `</span>`
      );
    })
    .join("");

/** the key and block the whole-stack review lives at - "all" is not a branch
    name (git forbids a bare path component to collide with nothing, but a
    layer keyed "all" would be a branch literally called all, so guard it) */
const aggregateKey = (entries: StackEntry[]): string =>
  entries.some((entry) => entry.key === "all") ? "all-layers" : "all";

/**
 * every authored layer in one reading order, for reviewing the stack as the
 * single change it will land as.
 *
 * Each file appears once, in the lowest layer that touches it - the layer that
 * introduces something is where reading it makes sense, and a file changed
 * again higher up is still the same file. Its note carries what every layer
 * said about it, each labelled with its layer, and it remembers which layers
 * those were so the page can say so on the row.
 */
const mergeLayers = (layers: AuthoredLayer[]): ReviewGroup[] => {
  // "PR 2/3" rather than the branch or the number: where a change sits in the
  // stack is what a reader needs, and it reads the same whether the stack has
  // been pushed or not
  const place = (index: number): string => `PR ${index + 1}/${layers.length}`;

  const notesByPath = new Map<string, { label: string; name: string; note: string }[]>();
  const layersByPath = new Map<string, { label: string; name: string }[]>();
  for (const [index, { entry, authored }] of layers.entries()) {
    const label = place(index);
    for (const group of authored.groups) {
      for (const item of group.items) {
        layersByPath.set(item.path, [
          ...(layersByPath.get(item.path) ?? []),
          { label, name: entry.label },
        ]);
        if (item.note !== undefined && item.note.trim() !== "") {
          notesByPath.set(item.path, [
            ...(notesByPath.get(item.path) ?? []),
            { label, name: entry.label, note: item.note },
          ]);
        }
      }
    }
  }

  /** one layer's note reads as itself; several are labelled, so it's clear
      which layer is talking about what it did */
  const noteFor = (path: string): string | undefined => {
    const notes = notesByPath.get(path) ?? [];
    const [only] = notes;
    if (only === undefined) {
      return undefined;
    }
    return notes.length === 1 ? only.note : (
        notes
          .map(
            ({ label, name, note }) =>
              `<span class="note-from"><span class="note-layer" title="${name}">${label}</span> ${note}</span>`,
          )
          .join("")
      );
  };

  const seen = new Set<string>();
  const groups: ReviewGroup[] = [];
  for (const [index, { entry, authored }] of layers.entries()) {
    for (const group of authored.groups) {
      const items: ReviewItem[] = group.items
        .filter((item) => !seen.has(item.path))
        .map((item) => {
          seen.add(item.path);
          return {
            ...item,
            ...(noteFor(item.path) === undefined ? {} : { note: noteFor(item.path) }),
            layers: layersByPath.get(item.path) ?? [{ label: place(index), name: entry.label }],
          };
        });
      if (items.length > 0) {
        groups.push({
          title: `${place(index)} (${entry.label}): ${group.title}`,
          ...(group.blurb === undefined ? {} : { blurb: group.blurb }),
          items,
        });
      }
    }
  }
  return groups;
};

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    out: { type: "string" },
    current: { type: "string" },
    repo: { type: "string" },
    "max-side-lines": { type: "string", default: "2000" },
    "max-images": { type: "string", default: "100" },
  },
});

if (values.dir === undefined || values.out === undefined) {
  console.log(
    "buildStack.ts --dir <stackDir> --out <review.html> [--current <pr>] [--repo <dir>]",
  );
  process.exit(1);
}
const stackDir = values.dir;
const outPath = values.out;

const repo = values.repo ?? git(process.cwd(), "rev-parse", "--show-toplevel").trim();
const stack = readResolvedStack(join(stackDir, "stack.json"));

/** the ref each layer's head is read from: a PR's fetched head
    (resolvePr.sh's convention), or the branch itself when the layer is only
    local and there is nothing to fetch */
const headRefOf = (entry: StackEntry): string =>
  entry.number === undefined ? entry.head : `refs/review/pr${entry.number}`;

const exists = (ref: string): boolean =>
  git(repo, "rev-parse", "--verify", "--quiet", ref).trim() !== "";

/** the trunk the bottom layer sits on, preferring the remote's copy where
    there is one - a stack nobody has pushed only has the local branch */
const trunkRef = (trunk: string): string => {
  // a local-only stack usually has no remote at all; fetching anyway would
  // print git's "'origin' does not appear to be a git repository" over a
  // build that is going fine
  if (git(repo, "remote").split("\n").includes("origin")) {
    try {
      git(repo, "fetch", "--quiet", "origin", `${trunk}:refs/remotes/origin/${trunk}`);
    } catch {
      try {
        git(repo, "fetch", "--quiet", "origin", trunk);
      } catch {
        /* offline - whatever was fetched before is what there is */
      }
    }
  }
  return exists(`origin/${trunk}`) ? `origin/${trunk}` : trunk;
};

const fetchRefs = (): void => {
  for (const entry of stack.entries) {
    if (entry.number === undefined) {
      // local-only: its branch in this checkout is the only copy
      if (!exists(entry.head)) {
        throw new Error(`${entry.head} is not a branch here - a local stack is reviewed from its own checkout`);
      }
      continue;
    }
    try {
      git(repo, "fetch", "--quiet", "--force", "origin", `refs/pull/${entry.number}/head:${headRefOf(entry)}`);
    } catch (error) {
      // offline is survivable if an earlier fetch left the ref behind
      if (!exists(headRefOf(entry))) {
        throw new Error(`could not fetch pr ${entry.number} and no ${headRefOf(entry)} exists locally`, {
          cause: error,
        });
      }
      console.error(`warning: fetching pr ${entry.number} failed; using the existing local ref`);
    }
  }
};

const main = async (): Promise<void> => {
  fetchRefs();

  const reviews: ShellReview[] = [];
  const reviewBlocks: string[] = [];
  const carried: string[] = [];
  const authoredLayers: AuthoredLayer[] = [];

  const [bottom] = stack.entries;
  if (bottom === undefined) {
    throw new Error("stack.json has no entries");
  }
  const trunk = trunkRef(bottom.base);

  for (const [index, entry] of stack.entries.entries()) {
    const groupsPath = join(stackDir, `${entry.key}.groups.json`);
    const bare: ShellReview = {
      key: entry.key,
      label: entry.label,
      title: entry.title,
      url: entry.url,
      head: entry.head,
    };

    if (!existsSync(groupsPath)) {
      const instructions = existsSync(join(stackDir, `${entry.key}.instructions.md`));
      reviews.push(instructions ? { ...bare, awaitingContribution: true } : bare);
      continue;
    }

    const authored = JSON.parse(readFileSync(groupsPath, "utf8")) as AuthoredGroups;
    authoredLayers.push({ entry, authored });
    const previousEntry = stack.entries[index - 1];
    const collected = collectReview(
      repo,
      {
        mode: "pr",
        // a stacked PR's base branch is the head of the PR below it, so the
        // fetched sibling head is the exact base ref
        base: previousEntry === undefined ? trunk : headRefOf(previousEntry),
        head: headRefOf(entry),
        ...(entry.number === undefined ? {} : { pr: String(entry.number) }),
        maxSideLines: Number(values["max-side-lines"]),
        maxImages: Number(values["max-images"]),
      },
      authored,
      `img-${entry.key}`,
    );

    reviews.push({
      ...bare,
      block: reviewBlockId(entry.key),
      reviewId: collected.payload.id,
      baseSha: collected.baseSha,
    });
    reviewBlocks.push(
      jsonBlock(reviewBlockId(entry.key), collected.payload),
      ...collected.imageBlocks,
    );
    carried.push(entry.key);

    console.log(
      `${entry.label}  ${Object.keys(collected.payload.stats).length} files, ${collected.imageBlocks.length} images  (${collected.payload.id})`,
    );
    for (const path of collected.empty) {
      console.error(`  warning: no diff found for ${path}`);
    }
  }

  const [firstCarried] = carried;
  if (firstCarried === undefined) {
    throw new Error(`no <key>.groups.json found in ${stackDir} - nothing to build`);
  }

  // every authored layer at once: the stack read as the one change it lands
  // as, measured from the trunk to the topmost layer anyone has reviewed
  if (authoredLayers.length > 1) {
    const top = authoredLayers.at(-1)?.entry;
    const labels = authoredLayers.map(({ entry }) => entry.label);
    const key = aggregateKey(stack.entries);
    if (top !== undefined) {
      const collected = collectReview(
        repo,
        {
          mode: "pr",
          base: trunk,
          head: headRefOf(top),
          maxSideLines: Number(values["max-side-lines"]),
          maxImages: Number(values["max-images"]),
        },
        {
          meta: {
            title: `All ${labels.length} PRs together`,
            headerTitle: "all PRs",
            eyebrow: "every PR at once",
            lede: stackSummary(authoredLayers),
            facts: [
              `measured from <code>${bottom.base}</code> to <code>${top.label}</code> - the change as it will land`,
              "each file once, under the first PR that touches it",
            ],
          },
          groups: mergeLayers(authoredLayers),
        },
        `img-${key}`,
      );
      reviews.push({
        key,
        label: "all",
        title: `every PR at once (${labels.join(" → ")})`,
        url: "",
        aggregate: true,
        block: reviewBlockId(key),
        reviewId: collected.payload.id,
        baseSha: collected.baseSha,
      });
      reviewBlocks.push(jsonBlock(reviewBlockId(key), collected.payload), ...collected.imageBlocks);
      carried.push(key);
      console.log(
        `all  ${Object.keys(collected.payload.stats).length} files, ${collected.imageBlocks.length} images  (${collected.payload.id})`,
      );
      for (const path of collected.empty) {
        console.error(`  warning: ${path} has no diff across the whole stack (changed then undone?)`);
      }
    }
  }

  // --current takes a key, a pr number or a branch, whichever the caller has
  const requested = stack.entries.find(
    (entry) =>
      values.current !== undefined &&
      [entry.key, entry.head, entry.number === undefined ? undefined : String(entry.number)].includes(
        values.current,
      ),
  )?.key;
  const current =
    requested !== undefined && carried.includes(requested) ? requested
    : carried.includes(stack.current) ? stack.current
    : firstCarried;

  const shell: ReviewShell = { reviews, current };
  const { script, css } = await buildPage();
  const html = page(shell, reviewBlocks, script, finishCss(css));
  writeFileSync(outPath, html, "utf8");

  console.log(
    `stack   ${reviews.map((review) => (review.key === current ? `[${review.label}]` : review.block === undefined ? `(${review.label})` : review.label)).join(" → ")}   (parens = not yet reviewed)`,
  );
  console.log(`wrote ${outPath}  (${Math.round(Buffer.byteLength(html) / 1_024)} KiB)`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
