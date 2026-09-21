/* What a conflict-resolution review compares: the side that was checked out
 * (current), the side being brought in (incoming), their common ancestor, and
 * the resolution - the working tree while a merge, rebase, cherry-pick or
 * revert is paused, or a finished merge commit.
 *
 * Which files are worth reading comes from git itself: `git merge-tree`
 * re-runs the merge git attempted and reports what it could not do on its
 * own (the conflicted files), and the tree it would have written, which the
 * resolution is diffed against to find anything the resolver changed beyond
 * git's own merge - including files that never conflicted at all.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type ConflictInfo, type ConflictFileKind } from "./src/ReviewPayload.ts";

export type ConflictOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "merge commit";

export type ConflictRefs = {
  operation: ConflictOperation;
  current: string;
  incoming: string;
  ancestor: string;
  /** "worktree" while the operation is paused, else the merge commit's sha */
  resolution: string;
  /** whether merge-tree should be told the ancestor (a replayed commit's
      parent) or left to find the merge base itself (a real merge) */
  explicitBase: boolean;
  info: Omit<ConflictInfo, "files">;
};

const run = (repo: string, ...args: string[]): string => {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 512 * 1_024 * 1_024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    // merge-tree exits 1 when the merge conflicts, diff when there are differences
    if (failure.status === 1) {
      return failure.stdout ?? "";
    }
    throw new Error(`git ${args.join(" ")} failed:\n${failure.stderr ?? ""}`, { cause: error });
  }
};

const revParse = (repo: string, ref: string): string | undefined => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const short = (repo: string, sha: string): string => run(repo, "rev-parse", "--short", sha).trim();

const subject = (repo: string, sha: string): string => {
  const text = run(repo, "log", "-1", "--format=%s", sha).trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/** a branch (or remote branch) name for a commit - relative to one, like
    main~1, where none points at it exactly - else its short sha */
const nameOf = (repo: string, sha: string): string => {
  const name = run(
    repo,
    "name-rev",
    "--name-only",
    "--no-undefined",
    "--refs=refs/heads/*",
    "--refs=refs/remotes/*",
    sha,
  ).trim();
  return name === "" ? short(repo, sha) : name.replace(/^remotes\//, "");
};

const checkedOutBranch = (repo: string): string => {
  const branch = run(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  return branch === "HEAD" ? short(repo, "HEAD") : branch;
};

/** a file under the git dir, eg rebase-merge/onto, or undefined */
const gitDirFile = (repo: string, name: string): string | undefined => {
  const path = resolve(repo, run(repo, "rev-parse", "--git-path", name).trim());
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
};

const parentOf = (repo: string, sha: string, what: string): string => {
  const parent = revParse(repo, `${sha}^`);
  if (parent === undefined) {
    throw new Error(`${what} ${short(repo, sha)} is a root commit - there is no ancestor to compare against`);
  }
  return parent;
};

/**
 * the refs of the conflict being reviewed: the finished merge commit `ref`
 * when given, else whichever operation is paused in the working tree
 */
export const resolveConflict = (repo: string, ref?: string): ConflictRefs => {
  if (ref !== undefined) {
    const merge = revParse(repo, ref);
    if (merge === undefined) {
      throw new Error(`${ref} is not a commit`);
    }
    const current = revParse(repo, `${merge}^1`);
    const incoming = revParse(repo, `${merge}^2`);
    if (current === undefined || incoming === undefined) {
      throw new Error(`${ref} is not a merge commit - conflict mode needs two parents to compare`);
    }
    return {
      operation: "merge commit",
      current,
      incoming,
      ancestor: run(repo, "merge-base", current, incoming).trim().split("\n")[0] ?? "",
      resolution: merge,
      explicitBase: false,
      info: {
        operation: "merge commit",
        current: { label: nameOf(repo, current), detail: `the merge's first parent (${short(repo, merge)}^1)` },
        incoming: { label: nameOf(repo, incoming), detail: `the merge's second parent (${short(repo, merge)}^2)` },
      },
    };
  }

  const head = revParse(repo, "HEAD");
  if (head === undefined) {
    throw new Error("HEAD is not a commit");
  }

  const mergeHead = revParse(repo, "MERGE_HEAD");
  if (mergeHead !== undefined) {
    return {
      operation: "merge",
      current: head,
      incoming: mergeHead,
      ancestor: run(repo, "merge-base", head, mergeHead).trim().split("\n")[0] ?? "",
      resolution: "worktree",
      explicitBase: false,
      info: {
        operation: "merge",
        current: { label: checkedOutBranch(repo), detail: "HEAD - the branch being merged into" },
        incoming: { label: nameOf(repo, mergeHead), detail: `MERGE_HEAD (${short(repo, mergeHead)}) - the branch being merged in` },
      },
    };
  }

  const rebaseHead = revParse(repo, "REBASE_HEAD");
  if (rebaseHead !== undefined) {
    const onto = gitDirFile(repo, "rebase-merge/onto") ?? gitDirFile(repo, "rebase-apply/onto");
    const branch = (gitDirFile(repo, "rebase-merge/head-name") ?? gitDirFile(repo, "rebase-apply/head-name"))?.replace(
      /^refs\/heads\//,
      "",
    );
    return {
      operation: "rebase",
      current: head,
      incoming: rebaseHead,
      ancestor: parentOf(repo, rebaseHead, "the commit being replayed"),
      resolution: "worktree",
      explicitBase: true,
      info: {
        operation: "rebase",
        current: {
          label: onto === undefined ? short(repo, head) : `onto ${nameOf(repo, onto)}`,
          detail: "HEAD - the branch being rebased onto, plus the commits already replayed",
        },
        incoming: {
          label: `${branch === undefined ? "" : `${branch} `}${short(repo, rebaseHead)}`,
          detail: `REBASE_HEAD - the commit being replayed: ${subject(repo, rebaseHead)}`,
        },
      },
    };
  }

  const pickHead = revParse(repo, "CHERRY_PICK_HEAD");
  if (pickHead !== undefined) {
    return {
      operation: "cherry-pick",
      current: head,
      incoming: pickHead,
      ancestor: parentOf(repo, pickHead, "the commit being picked"),
      resolution: "worktree",
      explicitBase: true,
      info: {
        operation: "cherry-pick",
        current: { label: checkedOutBranch(repo), detail: "HEAD - the branch being picked onto" },
        incoming: {
          label: short(repo, pickHead),
          detail: `CHERRY_PICK_HEAD - the commit being picked: ${subject(repo, pickHead)}`,
        },
      },
    };
  }

  const revertHead = revParse(repo, "REVERT_HEAD");
  if (revertHead !== undefined) {
    // a revert is a cherry-pick of the inverse change: the reverted commit is
    // the base, and its parent is the side being brought in
    return {
      operation: "revert",
      current: head,
      incoming: parentOf(repo, revertHead, "the commit being reverted"),
      ancestor: revertHead,
      resolution: "worktree",
      explicitBase: true,
      info: {
        operation: "revert",
        current: { label: checkedOutBranch(repo), detail: "HEAD - the branch the revert lands on" },
        incoming: {
          label: `revert ${short(repo, revertHead)}`,
          detail: `the reverted commit's parent - the revert of: ${subject(repo, revertHead)}`,
        },
      },
    };
  }

  throw new Error(
    "no merge, rebase, cherry-pick or revert is in progress here - pass --ref <merge commit> to review a finished merge",
  );
};

const nonEmptyLines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

/**
 * every file the resolution differs from git's own attempt at the merge in,
 * conflicted ones first: those git gave up on, then any the resolver changed
 * although git had merged them cleanly (or not changed at all)
 */
export const conflictFiles = (
  repo: string,
  refs: ConflictRefs,
): { path: string; status: string; kind: ConflictFileKind }[] => {
  const mergeTree = nonEmptyLines(
    run(
      repo,
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      ...(refs.explicitBase ? [`--merge-base=${refs.ancestor}`] : []),
      refs.current,
      refs.incoming,
    ),
  );
  const [autoTree, ...conflicted] = mergeTree;
  if (autoTree === undefined) {
    throw new Error("git merge-tree wrote no tree - it needs git 2.40 or later");
  }

  const resolutionArgs = refs.resolution === "worktree" ? [] : [refs.resolution];
  const edited = nonEmptyLines(run(repo, "diff", "--name-only", "--no-renames", autoTree, ...resolutionArgs));

  const kinds = new Map<string, ConflictFileKind>();
  for (const path of conflicted) {
    kinds.set(path, "conflicted");
  }
  for (const path of edited) {
    if (!kinds.has(path)) {
      kinds.set(path, "edited");
    }
  }
  if (kinds.size === 0) {
    return [];
  }

  // the status the rows show is against the current side - what the 2-way diff
  // shows - rather than against git's attempted merge
  const statuses = new Map(
    nonEmptyLines(
      run(repo, "diff", "--name-status", "--no-renames", refs.current, ...resolutionArgs, "--", ...kinds.keys()),
    ).map((line) => {
      const [status = "M", path = ""] = line.split("\t");
      return [path, status.slice(0, 1)] as const;
    }),
  );

  return [...kinds].map(([path, kind]) => ({ path, kind, status: statuses.get(path) ?? "M" }));
};
