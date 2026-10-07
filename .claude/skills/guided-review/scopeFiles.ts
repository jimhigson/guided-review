/* The files a review's scope covers, as git sees them now - what build.ts
 * notes as left out of the reading order, and what serve.ts compares the
 * reading order against while the review is open, to show files that have
 * come into scope since it was written.
 */

import { execFileSync } from "node:child_process";

export type ScopeFile = {
  path: string;
  /** git's own letter: A, M, D or R */
  status: string;
  /** where a renamed file was */
  from?: string;
};

/** the same files changedFiles.sh drops: no text to diff, no picture to compare */
const unreviewable = /\.(ico|icns|woff2?|ttf|otf|eot|mp3|opus|ogg|wav|m4a|mp4|webm|mov|pdf|zip|gz|br|bin|wasm)$/;

const git = (repo: string, ...args: string[]): string => {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 512 * 1_024 * 1_024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // diff exits 1 whenever there are differences, which is the normal case
    return (error as { stdout?: string }).stdout ?? "";
  }
};

/**
 * every file that differs between `base` and either `head` or, with no head,
 * the working tree - untracked files included, as additions
 */
export const scopeFiles = (repo: string, base: string, head: string | undefined): ScopeFile[] => {
  const listing = git(repo, "diff", "--name-status", "-M", base, ...(head === undefined ? [] : [head]));
  const files: ScopeFile[] = [];
  for (const line of listing.split("\n")) {
    const [status = "", first, second] = line.split("\t");
    if (first === undefined) {
      continue;
    }
    const letter = status.charAt(0);
    files.push(
      letter === "R" && second !== undefined ?
        { path: second, status: "R", from: first }
      : { path: first, status: letter },
    );
  }
  if (head === undefined) {
    for (const path of git(repo, "ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
      if (path !== "") {
        files.push({ path, status: "A" });
      }
    }
  }
  return files.filter((file) => !unreviewable.test(file.path));
};
