/* Editing any PR of a stack from the review page: a holding space for the
 * edits, committing or amending them, and restacking the PRs above.
 *
 * Everything here is git plumbing - a scratch index, hash-object, write-tree,
 * commit-tree, merge-tree, update-ref - so no edit and no replay needs a
 * checkout, touches anyone's working tree or index, or moves a branch until
 * the reader asks for it. What is pending is kept as refs, so it outlives the
 * server and any tool can see it:
 *
 *   refs/guided-review/hold/<branch>          the PR's held edits: a commit
 *                                             whose parent is the commit they
 *                                             were made against (the anchor)
 *   refs/guided-review/restack-from/<branch>  the PR's head before a commit
 *                                             or amend moved it - the PRs
 *                                             above still sit on this, until
 *                                             they are restacked
 *   refs/guided-review/resolved/<commit>/<onto>  a conflict replaying <commit>
 *                                             onto <onto>, resolved (by the
 *                                             agent, with restack.ts)
 *   refs/guided-review/backup/<branch>/<time> a branch's head before a move,
 *                                             and held edits from time to
 *                                             time (backup/hold/<branch>/…)
 *
 * Replaying is a three-way merge of each commit onto its new parent, in
 * memory (merge-tree). Only when everything replays cleanly does anything
 * move - all of it in one ref transaction, after the old heads are backed up.
 * A conflict moves nothing and says where it is.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const namespace = "refs/guided-review";
export const holdRef = (branch: string): string => `${namespace}/hold/${branch}`;
export const restackFromRef = (branch: string): string => `${namespace}/restack-from/${branch}`;
export const resolvedRef = (commit: string, onto: string): string => `${namespace}/resolved/${commit}/${onto}`;
const backupRef = (name: string, when: string): string => `${namespace}/backup/${name}/${when}`;

/** held edits are backed up when the last backup is older than this */
const backupEveryMs = 5 * 60 * 1_000;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Run = { status: number; stdout: string; stderr: string };

const run = (cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Run => {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1_024 * 1_024,
      input: options.input ?? "",
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

const git = (cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string => {
  const result = run(cwd, args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

/** a ref's commit, or undefined where there is no such ref */
export const refValue = (repo: string, ref: string): string | undefined => {
  const value = run(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout.trim();
  return value === "" ? undefined : value;
};

const parentsOf = (repo: string, commit: string): string[] =>
  git(repo, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ").slice(1);

const treeOf = (repo: string, commit: string): string => git(repo, ["rev-parse", `${commit}^{tree}`]).trim();

/** a file at a commit, or empty where it isn't there */
export const fileAt = (repo: string, commit: string, path: string): string =>
  run(repo, ["show", `${commit}:${path}`]).stdout;

/** how many lines a file gained and lost between two commits */
export const countsBetween = (repo: string, from: string, to: string, path: string): [number, number] => {
  const [added, removed] = run(repo, ["diff", "--numstat", from, to, "--", path]).stdout.split(/\s+/);
  return added !== undefined && /^\d+$/.test(added) && removed !== undefined ? [Number(added), Number(removed)] : [0, 0];
};

/** the files that differ between two commits, with git's status letter */
export const changedBetween = (repo: string, from: string, to: string): { path: string; status: string }[] =>
  git(repo, ["diff-tree", "-r", "--no-commit-id", "--name-status", from, to])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [status = "M", path = ""] = line.split("\t");
      return { path, status: status.charAt(0) };
    });

/** a backup's name: to the millisecond, so two moves in the same second
    don't collide */
const stamp = (): string => new Date().toISOString().replaceAll(/[-:.]/g, "");

export const subjectOf = (repo: string, commit: string): string => git(repo, ["log", "-1", "--format=%s", commit]).trim();

/**
 * a commit's author and message, as commit-tree takes them - and its
 * committer date. A remade commit keeps the date of what it was made from, so
 * the same replay always makes the same commits: a plan worked out twice
 * agrees with itself, and a conflict resolved for "this commit onto that
 * one" is still found the next time round
 */
const authorOf = (repo: string, commit: string): { env: NodeJS.ProcessEnv; message: string } => {
  const [name = "", email = "", date = "", committed = "", ...message] = git(repo, [
    "log",
    "-1",
    "--format=%an%x00%ae%x00%aI%x00%cI%x00%B",
    commit,
  ]).split("\u0000");
  return {
    env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: committed },
    message: `${message.join("\u0000").replace(/\n+$/, "")}\n`,
  };
};

/** a commit's own dates, for a new commit made from it to keep */
const datesOf = (repo: string, commit: string): NodeJS.ProcessEnv => {
  const [authored = "", committed = ""] = git(repo, ["log", "-1", "--format=%aI%x00%cI", commit]).trim().split("\u0000");
  return { GIT_AUTHOR_DATE: authored, GIT_COMMITTER_DATE: committed };
};

const commitTree = (repo: string, tree: string, parents: string[], message: string, env: NodeJS.ProcessEnv = {}): string =>
  git(repo, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], { input: message, env }).trim();

/** a commit's tree with one file's content replaced - in a scratch index, so
    no index or working tree anyone is using is touched */
const treeWith = (repo: string, commit: string, path: string, content: string): string => {
  const scratch = mkdtempSync(join(tmpdir(), "guided-review-index-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    git(repo, ["read-tree", commit], { env });
    const blob = git(repo, ["hash-object", "-w", "--stdin"], { input: content }).trim();
    const [mode = "100644"] = git(repo, ["ls-tree", commit, "--", path]).split(/\s/).filter((part) => part !== "");
    git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { env });
    return git(repo, ["write-tree"], { env }).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** moves a ref only if it is still where it was read - two saves racing
    fail one of them, rather than losing it */
const swapRef = (repo: string, ref: string, to: string | undefined, from: string | undefined): void => {
  if (to === undefined) {
    if (from !== undefined) {
      git(repo, ["update-ref", "-d", ref, from]);
    }
    return;
  }
  git(repo, ["update-ref", ref, to, from ?? "0".repeat(40)]);
};

/** a save that can't be made as asked - the page says why */
export class EditRefused extends Error {
  refused = true;
}

/** a PR's held edits: the commit holding them, and the commit they were made
    against */
export type Held = { commit: string; anchor: string };

export const heldOn = (repo: string, branch: string): Held | undefined => {
  const commit = refValue(repo, holdRef(branch));
  if (commit === undefined) {
    return undefined;
  }
  const [anchor = ""] = parentsOf(repo, commit);
  return { commit, anchor };
};

/**
 * a save, into the PR's holding space. `anchor` is the commit the file was
 * being read at; held edits made against another commit of the PR refuse it,
 * one holding space at a time. `expected` hashes the content the page was
 * editing, so a save from a stale page is refused rather than written over
 * what is held
 */
export const saveToHold = (
  repo: string,
  branch: string,
  anchor: string,
  path: string,
  content: string,
  expected: string,
): { sha: string; counts: [number, number]; held: boolean } => {
  const held = heldOn(repo, branch);
  if (held !== undefined && held.anchor !== anchor) {
    throw new EditRefused(
      `edits are already held after ${held.anchor.slice(0, 9)} on ${branch} - commit or amend them first`,
    );
  }
  const from = held?.commit ?? anchor;
  if (sha256(fileAt(repo, from, path)) !== expected) {
    throw new EditRefused(`${path} isn't what this page was editing - it changed since; reload to see it`);
  }
  if (held !== undefined && Date.now() - Number(git(repo, ["log", "-1", "--format=%ct", held.commit]).trim()) * 1_000 > backupEveryMs) {
    git(repo, ["update-ref", backupRef(`hold/${branch}`, stamp()), held.commit]);
  }
  const tree = treeWith(repo, from, path, content);
  // edited back to what the commit has: nothing is held any more
  const next =
    tree === treeOf(repo, anchor) ? undefined : (
      commitTree(repo, tree, [anchor], `Held edits on ${branch}\n\nMade in the guided review page, not committed yet.\n`)
    );
  swapRef(repo, holdRef(branch), next, held?.commit);
  return { sha: sha256(content), counts: countsBetween(repo, anchor, next ?? anchor, path), held: next !== undefined };
};

/** throws the held edits away - backed up first, in case */
export const discardHold = (repo: string, branch: string): void => {
  const held = heldOn(repo, branch);
  if (held === undefined) {
    return;
  }
  git(repo, ["update-ref", backupRef(`hold/${branch}`, stamp()), held.commit]);
  swapRef(repo, holdRef(branch), undefined, held.commit);
};

/** the commits a branch adds over its base, oldest first */
export const commitsOf = (repo: string, base: string, branch: string): string[] =>
  git(repo, ["rev-list", "--reverse", `${base}..${branch}`]).split("\n").filter((line) => line !== "");

export type Conflict = {
  branch: string;
  /** the commit that wouldn't replay, and what it was being replayed onto */
  commit: string;
  onto: string;
  subject: string;
  files: string[];
};

export type Move = { branch: string; from: string; to: string };

export type Plan = {
  moves: Move[];
  /** every commit remade, old to new - for whatever recorded the old ones */
  replaced: Map<string, string>;
  conflict?: Conflict;
  /** why it can't be done as things stand, for the reader */
  refused?: string;
};

/** one commit's change - made on `oldParent`, with `theirs` as its content -
    remade on `onto`, keeping `commit`'s author and message. A conflict
    resolved for exactly this commit and parent is taken as resolved */
const replay = (
  repo: string,
  commit: string,
  oldParent: string,
  onto: string,
  theirs: string,
): { commit: string } | { files: string[] } => {
  const { env, message } = authorOf(repo, commit);
  const resolved = refValue(repo, resolvedRef(commit, onto));
  if (resolved !== undefined) {
    return { commit: commitTree(repo, treeOf(repo, resolved), [onto], message, env) };
  }
  if (onto === oldParent) {
    return { commit: commitTree(repo, treeOf(repo, theirs), [onto], message, env) };
  }
  const merged = run(repo, ["merge-tree", "--write-tree", "--name-only", `--merge-base=${oldParent}`, onto, theirs]);
  const [tree = "", ...rest] = merged.stdout.split("\n");
  if (merged.status === 1) {
    const end = rest.indexOf("");
    return { files: (end === -1 ? rest : rest.slice(0, end)).filter((line) => line !== "") };
  }
  if (merged.status !== 0) {
    throw new Error(`git merge-tree failed replaying ${commit.slice(0, 9)}: ${merged.stderr.trim()}`);
  }
  return { commit: commitTree(repo, tree, [onto], message, env) };
};

/** a run of commits replayed onto a new parent, in order */
const replayAll = (
  repo: string,
  branch: string,
  commits: string[],
  onto: string,
  replaced: Map<string, string>,
): { tip: string } | { conflict: Conflict } => {
  let parent = onto;
  for (const commit of commits) {
    const [oldParent = ""] = parentsOf(repo, commit);
    if (parent === oldParent) {
      parent = commit;
      continue;
    }
    const replayed = replay(repo, commit, oldParent, parent, commit);
    if ("files" in replayed) {
      return { conflict: { branch, commit, onto: parent, subject: subjectOf(repo, commit), files: replayed.files } };
    }
    replaced.set(commit, replayed.commit);
    parent = replayed.commit;
  }
  return { tip: parent };
};

/**
 * the PR's held edits made into a commit: a new one, inserted after the
 * commit they were made against, or amended into that commit. The PR's
 * later commits are replayed on top
 */
export const planCommitHold = (
  repo: string,
  branch: string,
  how: { mode: "new"; message: string } | { mode: "amend" },
): Plan => {
  const held = heldOn(repo, branch);
  const tip = refValue(repo, `refs/heads/${branch}`);
  if (held === undefined || tip === undefined) {
    return { moves: [], replaced: new Map(), refused: held === undefined ? `nothing is held on ${branch}` : `${branch} is not a branch here` };
  }
  if (run(repo, ["merge-base", "--is-ancestor", held.anchor, tip]).status !== 0) {
    return { moves: [], replaced: new Map(), refused: `the commit the edits were made against is no longer on ${branch}` };
  }
  const replaced = new Map<string, string>();
  let made: string;
  if (how.mode === "new") {
    if (how.message.trim() === "") {
      return { moves: [], replaced, refused: "a new commit needs a message" };
    }
    made = commitTree(repo, treeOf(repo, held.commit), [held.anchor], `${how.message.trim()}\n`, datesOf(repo, held.commit));
  } else {
    const { env, message } = authorOf(repo, held.anchor);
    made = commitTree(repo, treeOf(repo, held.commit), parentsOf(repo, held.anchor), message, {
      ...env,
      GIT_COMMITTER_DATE: datesOf(repo, held.commit).GIT_COMMITTER_DATE,
    });
    replaced.set(held.anchor, made);
  }
  const later = commitsOf(repo, held.anchor, tip);
  const replayed = replayAll(repo, branch, later, made, replaced);
  if ("conflict" in replayed) {
    return { moves: [], replaced, conflict: replayed.conflict };
  }
  return { moves: [{ branch, from: tip, to: replayed.tip }], replaced };
};

/**
 * every PR that sits on an older head of the PR below it - one a commit or
 * amend moved, or one this restack itself moves - replayed onto that PR's
 * head now, from the lowest up. `layers` is the stack, trunk end first
 */
export const planRestack = (repo: string, layers: string[]): Plan => {
  const replaced = new Map<string, string>();
  const moves: Move[] = [];
  for (const [index, branch] of layers.entries()) {
    const below = layers[index - 1];
    if (below === undefined) {
      continue;
    }
    const tip = refValue(repo, `refs/heads/${branch}`);
    const belowNow = refValue(repo, `refs/heads/${below}`);
    if (tip === undefined || belowNow === undefined) {
      return { moves, replaced, refused: `${tip === undefined ? branch : below} is not a branch here` };
    }
    const movedHere = moves.find((move) => move.branch === below);
    const belowNew = movedHere?.to ?? belowNow;
    const belowOld = movedHere?.from ?? refValue(repo, restackFromRef(below));
    if (belowOld === undefined || run(repo, ["merge-base", "--is-ancestor", belowNew, tip]).status === 0) {
      // already on top of the PR below
      continue;
    }
    if (run(repo, ["merge-base", "--is-ancestor", belowOld, tip]).status !== 0) {
      return { moves, replaced, refused: `${branch} isn't on top of ${below} as it was - run gh stack rebase first` };
    }
    const replayed = replayAll(repo, branch, commitsOf(repo, belowOld, tip), belowNew, replaced);
    if ("conflict" in replayed) {
      return { moves, replaced, conflict: replayed.conflict };
    }
    moves.push({ branch, from: tip, to: replayed.tip });
  }
  return { moves, replaced };
};

/** the PRs that sit on an older head of the PR below - what a restack
    would replay. A PR moved by a commit or amend leaves the next one up
    stale, and so on up the stack */
export const staleAbove = (repo: string, layers: string[]): string[] => {
  const stale: string[] = [];
  for (const [index, branch] of layers.entries()) {
    const below = layers[index - 1];
    if (below === undefined) {
      continue;
    }
    // the PR below will move when restacked, so this one will too
    if (stale.includes(below)) {
      stale.push(branch);
      continue;
    }
    const belowNow = refValue(repo, `refs/heads/${below}`);
    const onTop = belowNow !== undefined && run(repo, ["merge-base", "--is-ancestor", belowNow, branch]).status === 0;
    if (refValue(repo, restackFromRef(below)) !== undefined && !onTop) {
      stale.push(branch);
    }
  }
  return stale;
};

/**
 * moves every branch the plan moves, in one transaction: old heads backed
 * up, and `also` (the refs the move settles) applied with it. A branch
 * checked out in `repo` takes its working tree along, keeping uncommitted
 * changes and refusing where they would be overwritten; one checked out in
 * any other worktree moves as a ref and nothing more
 */
export const applyPlan = (repo: string, plan: Plan, also: string[] = []): void => {
  if (plan.conflict !== undefined || plan.refused !== undefined) {
    throw new Error("a plan with a conflict can't be applied");
  }
  const checkedOut = run(repo, ["symbolic-ref", "-q", "HEAD"]).stdout.trim();
  const here = plan.moves.find((move) => `refs/heads/${move.branch}` === checkedOut);
  if (here !== undefined) {
    const carried = run(repo, ["read-tree", "-m", "-u", here.from, here.to]);
    if (carried.status !== 0) {
      throw new Error(`uncommitted changes in the checkout are in the way of moving ${here.branch}: ${carried.stderr.trim()}`);
    }
  }
  const when = stamp();
  const commands = [
    "start",
    ...plan.moves.flatMap((move) => [
      `update refs/heads/${move.branch} ${move.to} ${move.from}`,
      `create ${backupRef(move.branch, when)} ${move.from}`,
    ]),
    ...also,
    "commit",
    "",
  ];
  const moved = run(repo, ["update-ref", "--stdin"], { input: commands.join("\n") });
  if (moved.status !== 0) {
    if (here !== undefined) {
      run(repo, ["read-tree", "-m", "-u", here.to, here.from]);
    }
    throw new Error(`moving the branches failed, so none moved: ${moved.stderr.trim()}`);
  }
};

/** what committing the held edits settles: the hold itself, and - where PRs
    sit above this one - where they were based, unless an earlier move
    already recorded it (they sit on the oldest head, not the latest) */
export const commitHoldRefs = (repo: string, branch: string, plan: Plan, hasAbove: boolean): string[] => {
  const held = heldOn(repo, branch);
  const [move] = plan.moves;
  return [
    ...(held === undefined ? [] : [`delete ${holdRef(branch)} ${held.commit}`]),
    ...(hasAbove && move !== undefined && refValue(repo, restackFromRef(branch)) === undefined ?
      [`create ${restackFromRef(branch)} ${move.from}`]
    : []),
  ];
};

/** what a restack settles: every PR's record of where its PRs above sat,
    and the resolutions it used */
export const restackRefs = (repo: string, layers: string[], plan: Plan): string[] => [
  ...layers.flatMap((branch) => {
    const from = refValue(repo, restackFromRef(branch));
    return from === undefined ? [] : [`delete ${restackFromRef(branch)} ${from}`];
  }),
  ...resolutionsUsed(repo, plan),
];

const resolutionsUsed = (repo: string, plan: Plan): string[] =>
  git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", `${namespace}/resolved`])
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [name = "", value = ""] = line.split(" ");
      const commit = name.split("/").at(-2) ?? "";
      return plan.replaced.has(commit) ? [`delete ${name} ${value}`] : [];
    });

/** a conflict set up to be resolved in a scratch worktree: the new parent
    checked out, the commit's change merged into it, and each file that
    wouldn't merge left with conflict markers, labelled with what each side is */
export const setUpResolution = (repo: string, conflict: Conflict, dir: string): string[] => {
  git(repo, ["worktree", "add", "--detach", dir, conflict.onto]);
  const [oldParent = ""] = parentsOf(repo, conflict.commit);
  run(dir, ["read-tree", "-m", "-u", "--aggressive", oldParent, conflict.onto, conflict.commit]);
  const stages = new Map<string, Map<string, string>>();
  for (const line of run(dir, ["ls-files", "-u"]).stdout.split("\n").filter((entry) => entry !== "")) {
    const [info = "", path = ""] = line.split("\t");
    const [, blob = "", stage = ""] = info.split(" ");
    stages.set(path, (stages.get(path) ?? new Map()).set(stage, blob));
  }
  const scratch = mkdtempSync(join(tmpdir(), "guided-review-merge-"));
  try {
    for (const [path, byStage] of stages) {
      const side = (stage: string): string => {
        const file = join(scratch, `stage${stage}`);
        const blob = byStage.get(stage);
        writeFileSync(file, blob === undefined ? "" : git(repo, ["cat-file", "blob", blob]));
        return file;
      };
      const merged = run(dir, [
        "merge-file",
        "-p",
        "-L",
        `${conflict.onto.slice(0, 9)} (what it now goes on top of)`,
        "-L",
        "base",
        "-L",
        `${conflict.commit.slice(0, 9)} ${conflict.subject}`,
        side("2"),
        side("1"),
        side("3"),
      ]);
      writeFileSync(join(dir, path), merged.stdout);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return [...stages.keys()];
};

/** a resolution finished in its scratch worktree, recorded for the replay to
    use next time - then the worktree is removed */
export const recordResolution = (repo: string, dir: string, conflict: Conflict): string => {
  const markers = run(dir, ["grep", "-n", "-I", "-E", "^(<<<<<<<|>>>>>>>)( |$)"]).stdout.trim();
  if (markers !== "") {
    throw new Error(`there are still conflict markers in ${dir}:\n${markers}`);
  }
  git(dir, ["add", "-A"]);
  const tree = git(dir, ["write-tree"]).trim();
  const { env, message } = authorOf(repo, conflict.commit);
  const resolution = commitTree(repo, tree, [conflict.onto], message, env);
  git(repo, ["update-ref", resolvedRef(conflict.commit, conflict.onto), resolution]);
  git(repo, ["worktree", "remove", "--force", dir]);
  return resolution;
};
