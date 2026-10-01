/* Reading a PR's comments off the forge, and replying to them - everything
 * here shells out to `gh`, which the PR modes already depend on.
 *
 * Only GitHub: `gh` is a GitHub client, and every other forge words its review
 * threads differently. A review whose branch has no PR simply has none of this.
 */

import { execFileSync } from "node:child_process";

import {
  type GithubComment,
  type GithubReview,
  type GithubThread,
  type GithubVerdict,
} from "./src/githubTypes.ts";

const gh = (repo: string, ...args: string[]): string =>
  execFileSync("gh", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** owner/name of the repo's origin, as the api wants them */
export const repoSlug = (repo: string): { owner: string; name: string } => {
  const full = JSON.parse(gh(repo, "repo", "view", "--json", "nameWithOwner")) as {
    nameWithOwner: string;
  };
  const [owner = "", name = ""] = full.nameWithOwner.split("/");
  return { owner, name };
};

/** the open PR for a branch, where there is one - a stack layer nobody has
    pushed has no PR, and neither has a commit or working-tree review */
export const prForBranch = (repo: string, branch: string): number | undefined => {
  try {
    const found = JSON.parse(
      gh(repo, "pr", "list", "--head", branch, "--state", "all", "--json", "number,state", "--limit", "10"),
    ) as { number: number; state: string }[];
    // an open PR wins over a closed one for the same branch
    return (found.find((pr) => pr.state === "OPEN") ?? found[0])?.number;
  } catch {
    return undefined;
  }
};

const query = `
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      number url title state
      comments(last: 100) { nodes { author { login } body createdAt url } }
      reviews(last: 100) { nodes { author { login } state body createdAt url } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line diffSide
          comments(first: 100) { nodes { databaseId author { login } body createdAt url } }
        }
      }
    }
  }
}`;

type RawComment = {
  databaseId?: number;
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  url?: string;
  state?: string;
};

type RawPullRequest = {
  number: number;
  url: string;
  title: string;
  state: string;
  comments: { nodes: RawComment[] };
  reviews: { nodes: RawComment[] };
  reviewThreads: {
    nodes: {
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      diffSide: "LEFT" | "RIGHT";
      comments: { nodes: RawComment[] };
    }[];
  };
};

const commentOf = (raw: RawComment): GithubComment => ({
  author: raw.author?.login ?? "someone",
  body: raw.body ?? "",
  createdAt: raw.createdAt ?? "",
  url: raw.url ?? "",
});

/** everything the forge has to say about one PR */
export const fetchPrComments = (repo: string, pr: number): GithubReview => {
  const { owner, name } = repoSlug(repo);
  const answer = JSON.parse(
    gh(
      repo,
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ),
  ) as { data?: { repository?: { pullRequest?: RawPullRequest } } };

  const pull = answer.data?.repository?.pullRequest;
  if (pull === undefined) {
    throw new Error(`no pull request ${pr} in ${owner}/${name}`);
  }

  const threads: GithubThread[] = pull.reviewThreads.nodes.flatMap((thread) => {
    const [first] = thread.comments.nodes;
    if (first?.databaseId === undefined) {
      return [];
    }
    return [
      {
        id: thread.id,
        replyTo: first.databaseId,
        path: thread.path,
        ...(thread.line === null ? {} : { line: thread.line }),
        side: thread.diffSide,
        outdated: thread.isOutdated,
        resolved: thread.isResolved,
        url: first.url ?? pull.url,
        comments: thread.comments.nodes.map(commentOf),
      },
    ];
  });

  const verdicts: GithubVerdict[] = pull.reviews.nodes
    // a review with no words and no verdict is the shell of an inline comment,
    // which is already in its thread
    .filter((review) => (review.body ?? "") !== "" || (review.state ?? "COMMENTED") !== "COMMENTED")
    .map((review) => ({ ...commentOf(review), state: review.state ?? "COMMENTED" }));

  return {
    pr: pull.number,
    url: pull.url,
    title: pull.title,
    state: pull.state,
    fetchedAt: new Date().toISOString(),
    threads,
    conversation: pull.comments.nodes.map(commentOf),
    verdicts,
  };
};

/** answers an inline thread, in that thread */
export const replyToThread = (repo: string, pr: number, replyTo: number, body: string): void => {
  const { owner, name } = repoSlug(repo);
  gh(
    repo,
    "api",
    "--method",
    "POST",
    `repos/${owner}/${name}/pulls/${pr}/comments/${replyTo}/replies`,
    "-f",
    `body=${body}`,
  );
};

/** answers the PR itself, in its conversation */
export const commentOnPr = (repo: string, pr: number, body: string): void => {
  gh(repo, "pr", "comment", String(pr), "--body", body);
};
