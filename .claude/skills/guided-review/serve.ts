#!/usr/bin/env node
/* Serve a built guided review, with save-back, note and tick persistence.
 *
 * The page build.ts / buildStack.ts writes is static and read-only. Served
 * through here it gains three things: the modified side of each Monaco diff
 * becomes editable with a Save button that writes to the working tree, and
 * review notes and ticks persist to json files instead of localStorage.
 *
 *   node serve.ts --html <scratchpad>/review.html [--repo .] [--port 0] [--open]
 *
 * A page can carry several reviews (a PR stack); each keeps its own files, in
 * a directory named after its review id, beside the html:
 *
 *   <scratchpad>/<review id>/{ticks.json, notes.json, notes.md, token}
 *
 * so rebuilding the same review anywhere picks up the progress it already
 * has. The shell is re-read when the html changes on disk, so a stack review
 * contributed later (rebuild in place) gets its store without a restart.
 *
 * Only the review whose head branch the --repo checkout has on disk may save
 * back - the others' editors are read-only, their notes and ticks still live.
 * Localhost only, and every write is gated on a token kept beside the review
 * plus the sha256 the page was built from - a file that moved on disk since
 * then is a 409, not a silent clobber.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/* the notes file is hand-editable and written while it is being read, so what
   comes off disk is described as what it may actually be rather than as what
   the page writes */

type NoteMessage = { from?: string; text?: string; asking?: boolean };

type Note = {
  line?: number;
  /** the single-text shape a note started as */
  text?: string;
  messages?: NoteMessage[];
  /** how many messages an agent has confirmed seeing - see ackNote.ts */
  ackedThrough?: number;
};

type Notes = Record<string, Note[]>;

/** the slice of the page's shell this server routes on */
type ShellReview = {
  label: string;
  head?: string;
  reviewId?: string;
  baseSha?: string;
  baseRef?: string;
  headSha?: string;
  block?: string;
};

/** the slice of a review's payload this server reads */
type PayloadSlice = {
  groups: { commit?: string; live?: boolean; items: { path: string }[] }[];
  leftOut?: string[];
};

/** a git command's trimmed output, or undefined when it fails */
const gitOut = (repo: string, ...args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

import { commentOnPr, fetchPrComments, replyToThread } from "./github.ts";
import { type GithubReview } from "./src/githubTypes.ts";
import { nameOfCommit } from "./reviewAssembly.ts";
import { parseNameStatus, type ScopeFile, scopeFiles, untrackedFiles } from "./scopeFiles.ts";
import { type RebuildRecipe, type ReviewStop, stagedRef, workingRef } from "./src/ReviewPayload.ts";

const marker = "<!--REVIEW_SERVER-->";
const shellPattern = /<script type="application\/json" id="shell">(?<json>[\s\S]*?)<\/script>/;

/* monaco is served from this skill's own install - the page has no other
   source for it, so its absence is a startup failure, not a degraded mode */
const skillDir = dirname(fileURLToPath(import.meta.url));
const monacoDir = join(skillDir, "node_modules", "monaco-editor", "min", "vs");
if (!existsSync(join(monacoDir, "loader.js"))) {
  throw new Error(
    `monaco is not installed at ${monacoDir} - run \`pnpm install --ignore-workspace\` in ${skillDir}`,
  );
}

const monacoMimes: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

const serveMonaco = (path: string, response: ServerResponse): void => {
  const target = join(monacoDir, path.slice("/vs/".length));
  const inside = relative(monacoDir, target);
  if (inside.startsWith("..") || !existsSync(target) || !statSync(target).isFile()) {
    respondJson(response, 404, { error: `no such monaco file: ${path}` });
    return;
  }
  const body = readFileSync(target);
  response.writeHead(200, {
    "Content-Type": monacoMimes[extname(target)] ?? "application/octet-stream",
    "Content-Length": body.length,
    // versioned by the monaco install itself; the browser can keep it
    "Cache-Control": "max-age=86400",
  });
  response.end(body);
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

type Options = { html: string; repo: string; port: number; open: boolean };

const parseOptions = (): Options => {
  const { values } = parseArgs({
    options: {
      html: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      port: { type: "string", default: "0" },
      open: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help === true || values.html === undefined) {
    console.log("serve.ts --html <review.html> [--repo .] [--port 0] [--open]");
    process.exit(values.html === undefined ? 1 : 0);
  }
  return {
    html: resolve(values.html),
    repo: resolve(values.repo),
    port: Number(values.port),
    open: values.open,
  };
};

/** a note is a thread; the single-text shape it started as reads as its first
    message. Never raises: a half-written or hand-edited note file must not take
    the server down mid-review */
const normalise = (note: Note): Note => {
  if (Array.isArray(note.messages)) {
    return note;
  }
  const first: NoteMessage[] =
    note.text === undefined ? [] : [{ from: "reviewer", text: note.text }];
  return { line: note.line ?? 1, messages: first };
};

const flatten = (notes: Notes): Set<string> =>
  new Set(
    Object.entries(notes).flatMap(([path, forPath]) =>
      forPath
        .map(normalise)
        .flatMap((note) =>
          (note.messages ?? []).map(
            (message) => `${path}:${note.line} ${message.from}: ${message.text}`,
          ),
        ),
    ),
  );

const asMarkdown = (notes: Notes): string => {
  const thread = (raw: Note): string => {
    const note = normalise(raw);
    const messages = note.messages ?? [];
    const [first, ...rest] = messages;
    if (first === undefined) {
      return "";
    }
    const head = `- L${note.line}: ${first.text ?? ""}`;
    const replies = rest.map((message) => `  - ${message.from ?? "?"}: ${message.text ?? ""}`);
    return replies.length > 0 ? `${head}\n${replies.join("\n")}` : head;
  };

  return Object.entries(notes)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, forPath]) => {
      const threads = forPath.map(thread).filter((line) => line !== "");
      return threads.length > 0 ? `### ${path}\n${threads.join("\n")}` : "";
    })
    .filter((section) => section !== "")
    .join("\n\n");
};

/** one review's persistence: its ticks and notes files, named by its id */
class ReviewStore {
  id: string;
  /** how this review is named in the server's own output */
  label: string;
  /** the commit this review's diff is measured from - live line counts diff
      against this, never the working checkout's index, so they always read
      against the same base the review itself does. Moves when `baseRef`
      does: the page is rebuilt when it moves, and this follows the page */
  baseSha: string;
  /** the head commit the page was built at - see ShellReview.headSha */
  headSha: string | undefined;
  /** what the before side follows (ShellReview.baseRef), and the head it is
      measured against - absent where the before side is history */
  baseRef: string | undefined;
  head: string | undefined;
  /** what moved the branch last, as the reflog put it ("rebase (finish)…") */
  movedBecause = "";
  /** a rebuild is running, or failed for this head and base - not retried
      until one of them moves again */
  rebuilding = false;
  failedFor = "";
  /** why the last rebuild failed, for the page to say - cleared by one that works */
  failure = "";
  /** the files the reading order lists, and those it leaves out on purpose -
      what a file coming into scope is new against */
  listed = new Set<string>();
  leftOut = new Set<string>();
  /** read commit by commit: its rows are history, and the scope isn't followed */
  perCommit = false;
  /** what has been said about the scope already, so each is said once */
  #announced = new Set<string>();
  notesFile: string;
  notesMarkdown: string;
  ticksFile: string;
  /** what prComments.ts last read off the forge for this review */
  githubFile: string;
  #seen: Set<string>;

  constructor(
    htmlDir: string,
    id: string,
    label: string,
    baseSha: string,
    baseRef: string | undefined,
    head: string | undefined,
  ) {
    this.id = id;
    this.label = label;
    this.baseSha = baseSha;
    this.baseRef = baseRef;
    this.head = head;
    const dir = join(htmlDir, id);
    mkdirSync(dir, { recursive: true });
    this.notesFile = join(dir, "notes.json");
    this.notesMarkdown = join(dir, "notes.md");
    this.ticksFile = join(dir, "ticks.json");
    this.githubFile = join(dir, "github.json");
    this.#seen = flatten(this.readNotes());
  }

  /** says, once each, what has come into scope since the reading order was
      written and what in it no longer differs - for the agent watching this
      output to place in the groups json */
  announceScope(scope: ScopeFile[]): void {
    const inScope = new Set(scope.map((file) => file.path));
    const said: string[] = [];
    for (const file of scope) {
      if (!this.listed.has(file.path) && !this.leftOut.has(file.path)) {
        said.push(
          `new in scope: ${file.path} (${file.status}${file.from === undefined ? "" : ` from ${file.from}`}) - not in the reading order`,
        );
      }
    }
    for (const path of this.listed) {
      if (!inScope.has(path)) {
        said.push(`not in the change any more: ${path}`);
      }
    }
    for (const line of said.filter((entry) => !this.#announced.has(entry))) {
      console.log(`  ${this.label === "" ? "" : `${this.label} `}${line}`);
    }
    this.#announced = new Set(said);
  }

  static read(path: string): string {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "";
  }

  /** same tolerance as the notes: a half-written or hand-edited file must not
      take the server down mid-review */
  readTicks(): string[] {
    try {
      const read: unknown = JSON.parse(ReviewStore.read(this.ticksFile) || "[]");
      return Array.isArray(read) ? (read as string[]) : [];
    } catch {
      return [];
    }
  }

  writeTicks(ticked: string[]): void {
    writeFileSync(this.ticksFile, JSON.stringify(ticked, null, 2), "utf8");
  }

  /** the PR's comments, when prComments.ts has read them - undefined when it
      hasn't run, or the review has no PR behind it at all */
  readGithub(): GithubReview | undefined {
    const raw = ReviewStore.read(this.githubFile);
    if (raw === "") {
      return undefined;
    }
    try {
      return JSON.parse(raw) as GithubReview;
    } catch {
      // written while being read, like the notes - the next poll gets it whole
      return undefined;
    }
  }

  readNotes(): Notes {
    // requests are served concurrently, so the notes file can be read while
    // another request is part-way through writing it. Reading no notes for one
    // request is recoverable; taking the server down mid-review is not
    let raw: Notes;
    try {
      raw = JSON.parse(ReviewStore.read(this.notesFile) || "{}") as Notes;
    } catch {
      return {};
    }
    return Object.fromEntries(
      Object.entries(raw).map(([path, forPath]) => [path, forPath.map(normalise)]),
    );
  }

  writeNotes(notes: Notes): void {
    writeFileSync(this.notesFile, JSON.stringify(notes, null, 2), "utf8");
    // the markdown twin is what a person or an agent actually reads
    writeFileSync(this.notesMarkdown, asMarkdown(notes), "utf8");
    const now = flatten(notes);
    for (const line of [...now].filter((entry) => !this.#seen.has(entry)).sort()) {
      console.log(`  note ${this.label} ${line}`);
    }
    this.#seen = now;
  }

  /** put the notes where the agent running the skill will find them */
  handOff(notes: Notes): number {
    this.writeNotes(notes);
    const count = flatten(notes).size;
    console.log(`\n=== ${count} review note(s) handed off (${this.label}) ===`);
    console.log(`    read ${this.notesMarkdown}`);
    console.log(asMarkdown(notes));
    console.log("=== end of notes ===\n");
    return count;
  }
}

class ReviewPage {
  html: string;
  repo: string;
  token: string;
  #stores = new Map<string, ReviewStore>();
  #shellMtimeMs = -1;
  #reviews: ShellReview[] = [];
  /** how the page was built, for building it again - see RebuildRecipe */
  #recipe: RebuildRecipe | undefined;

  constructor(html: string, repo: string) {
    this.html = html;
    this.repo = resolve(repo);
    this.#refreshShell();
    const [firstStore] = this.#stores.values();
    if (firstStore === undefined) {
      throw new Error(`${html} carries no reviews - rebuild it with the current build.ts`);
    }
    this.token = ReviewPage.stableToken(join(dirname(html), firstStore.id, "token"));
  }

  /** kept across restarts, so a page left open in a tab keeps working.
      Its job is only to stop some other page in the browser posting to this
      port behind your back - it is not protecting the review from you, and
      losing notes to a restart would be a far worse failure than the one it
      guards against */
  static stableToken(tokenFile: string): string {
    if (existsSync(tokenFile)) {
      return readFileSync(tokenFile, "utf8").trim();
    }
    const token = randomBytes(24).toString("base64url");
    writeFileSync(tokenFile, token, "utf8");
    chmodSync(tokenFile, 0o600);
    return token;
  }

  /** the html is rebuilt in place as stack reviews are contributed; the shell
      (and so the store list) follows it without a restart */
  #refreshShell(): void {
    const { mtimeMs } = statSync(this.html);
    if (mtimeMs === this.#shellMtimeMs) {
      return;
    }
    this.#shellMtimeMs = mtimeMs;
    const found = shellPattern.exec(readFileSync(this.html, "utf8"));
    if (found?.groups?.json === undefined) {
      throw new Error(`${this.html} carries no shell - rebuild it with the current build.ts`);
    }
    const shell = JSON.parse(found.groups.json) as { reviews: ShellReview[] };
    this.#reviews = shell.reviews;
    const carried = shell.reviews.filter(
      (review): review is ShellReview & { reviewId: string } => review.reviewId !== undefined,
    );
    const labelled = carried.length > 1;
    const html = readFileSync(this.html, "utf8");
    this.#recipe = ReviewPage.payloadOf(html, "recipe") as RebuildRecipe | undefined;
    for (const review of carried) {
      if (!this.#stores.has(review.reviewId)) {
        this.#stores.set(
          review.reviewId,
          new ReviewStore(
            dirname(this.html),
            review.reviewId,
            labelled ? review.label : "",
            // a page built before baseSha existed falls back to HEAD - the old,
            // less exact comparison, rather than failing to serve at all
            review.baseSha ?? "HEAD",
            review.baseRef,
            review.head,
          ),
        );
      }
      const store = this.#stores.get(review.reviewId);
      // a rebuild writes a new page: the store follows what it was built at
      if (store !== undefined) {
        store.baseSha = review.baseSha ?? store.baseSha;
        store.headSha = review.headSha;
        store.baseRef = review.baseRef;
        store.head = review.head;
      }
      const payload = review.block === undefined ? undefined : ReviewPage.payloadOf(html, review.block);
      if (store !== undefined && payload !== undefined) {
        store.listed = new Set(
          payload.groups
            .filter((group) => group.commit === undefined && group.live !== true)
            .flatMap((group) => group.items.map((item) => item.path)),
        );
        store.leftOut = new Set(payload.leftOut ?? []);
        store.perCommit = payload.groups.some((group) => group.commit !== undefined);
      }
    }
  }

  /** the part of a review's inert payload block this server routes on */
  static payloadOf(html: string, block: string): PayloadSlice | undefined {
    const start = html.indexOf(`<script type="application/json" id="${block}">`);
    if (start === -1) {
      return undefined;
    }
    const from = html.indexOf(">", start) + 1;
    const to = html.indexOf("</script>", from);
    try {
      return JSON.parse(html.slice(from, to)) as PayloadSlice;
    } catch {
      return undefined;
    }
  }

  stores(): ReviewStore[] {
    this.#refreshShell();
    return [...this.#stores.values()];
  }

  store(reviewIdParam: null | string): ReviewStore | undefined {
    this.#refreshShell();
    if (reviewIdParam !== null) {
      return this.#stores.get(reviewIdParam);
    }
    // a page built before stacks sends no review param; with one store there
    // is nothing to disambiguate
    const all = [...this.#stores.values()];
    const [only] = all;
    return all.length === 1 ? only : undefined;
  }

  /** the review the served checkout is - the only one allowed to save back,
      and the only one whose files are synced from disk at all. A review with
      no head names no branch to be on (worktree and commit modes review the
      checkout itself), so it is that by definition. One that does name a
      branch has to be on it, even when it is the only review in the page:
      without that a PR served from a checkout of some other branch reads
      that checkout's files over the diff, and saves into them.

      The head is matched by branch name, which holds through new commits,
      rebases and amends - the build records the branch even when it was
      given HEAD or a sha (headBranchOf). A head that is still a bare sha
      matches a checkout that contains it. In a stack every layer below the
      checked-out one is contained in it too, so the nearest wins. Files that
      changed since the build are guarded separately: a save is refused when
      the file on disk isn't what the page last read. */
  editable(): { reviewId?: string; reason?: string } {
    this.#refreshShell();
    const carried = this.#reviews.filter((review) => review.reviewId !== undefined);
    const [only] = carried;
    if (carried.length === 1 && only?.head === undefined) {
      return { reviewId: only?.reviewId };
    }
    const branch = gitOut(this.repo, "rev-parse", "--abbrev-ref", "HEAD");
    const byName = carried.find((review) => review.head === branch);
    if (byName !== undefined) {
      return { reviewId: byName.reviewId };
    }
    const contained = carried.filter(
      (review) =>
        review.head !== undefined &&
        gitOut(this.repo, "merge-base", "--is-ancestor", review.head, "HEAD") !== undefined,
    );
    const nearest = contained.find((review) =>
      contained.every(
        (other) =>
          other === review ||
          gitOut(this.repo, "merge-base", "--is-ancestor", other.head ?? "", review.head ?? "") !==
            undefined,
      ),
    );
    if (nearest !== undefined) {
      return { reviewId: nearest.reviewId };
    }
    const heads = carried.map((review) => review.head ?? "?").join(", ");
    const at = gitOut(this.repo, "rev-parse", "--short", "HEAD") ?? "?";
    return {
      reason: `the checkout is ${branch === "HEAD" ? "detached" : `on ${branch ?? "?"}`} at ${at}, not ${heads}`,
    };
  }

  editableReviewId(): string | undefined {
    return this.editable().reviewId;
  }

  /** where the review's before side should be read from now: where its head
      left its base ref - which a rebase, or merging the base in, moves - or
      the base ref itself where there is no head (HEAD, under a working tree) */
  baseNow(store: ReviewStore): string {
    if (store.baseRef === undefined) {
      return store.baseSha;
    }
    const base =
      store.head === undefined ?
        gitOut(this.repo, "rev-parse", store.baseRef)
      : gitOut(this.repo, "merge-base", store.baseRef, store.head);
    return base === undefined || base === "" ? store.baseSha : base;
  }

  /** git is part-way through rewriting the branch: a rebase stops at every
      conflict, and the review waits for it to finish rather than rebuilding
      at each step */
  #midOperation(): boolean {
    return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"].some((name) => {
      const at = gitOut(this.repo, "rev-parse", "--git-path", name);
      return at !== undefined && existsSync(resolve(this.repo, at));
    });
  }

  /**
   * the branch or its base has moved since the page was built - a commit, a
   * rebase, an amend, merging the base in: build the review again, the same
   * way it was first built, so that everything worked out from them (sides,
   * counts, moved code, renames, images) is as a fresh build would make it.
   * Notes and ticks are the review's own files, kept by its pinned id. The
   * page notices the new build on its next poll and takes it in
   */
  maybeRebuild(store: ReviewStore): void {
    const recipe = this.#recipe;
    if (recipe === undefined || store.rebuilding || store.headSha === undefined || this.#midOperation()) {
      return;
    }
    const head = gitOut(this.repo, "rev-parse", store.head ?? "HEAD");
    const base = this.baseNow(store);
    const now = `${head ?? ""} ${base}`;
    if (head === undefined || (head === store.headSha && base === store.baseSha) || now === store.failedFor) {
      return;
    }
    store.rebuilding = true;
    store.movedBecause = gitOut(this.repo, "reflog", "-1", "--format=%gs", store.head ?? "HEAD") ?? "";
    console.log(
      `  the branch moved${store.movedBecause === "" ? "" : ` (${store.movedBecause})`} - rebuilding the review`,
    );
    const dir = join(dirname(this.html), store.id);
    const groups = join(dir, "rebuild-groups.json");
    const leftOut = join(dir, "rebuild-left-out.json");
    writeFileSync(groups, JSON.stringify(recipe.authored, null, 2), "utf8");
    writeFileSync(leftOut, JSON.stringify(recipe.leftOut), "utf8");
    const build = join(dirname(fileURLToPath(import.meta.url)), "build.ts");
    const child = spawn(
      process.execPath,
      [build, ...recipe.args, "--groups", groups, "--left-out", leftOut, "--out", this.html],
      { cwd: this.repo, stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      store.rebuilding = false;
      if (code === 0) {
        store.failedFor = "";
        store.failure = "";
        console.log(`  rebuilt the review at ${head.slice(0, 9)}`);
      } else {
        store.failedFor = now;
        const lines = errors.trim().split("\n");
        const last = lines.slice(-5);
        // the thrown error's own line, not the stack trace or object dump after it
        store.failure =
          lines.find((line) => /^\s*(\w*Error|error|fatal):/.test(line))?.trim() ?? last[last.length - 1] ?? "build.ts failed";
        console.log(`  rebuilding the review failed:\n${last.join("\n")}`);
      }
    });
  }

  /** one carried review as the page has it now: its shell entry, payload and
      image blocks, raw - what a page takes in after a rebuild */
  built(store: ReviewStore): { review: ShellReview; payload: string; images: Record<string, string> } | undefined {
    this.#refreshShell();
    const review = this.#reviews.find((candidate) => candidate.reviewId === store.id);
    if (review?.block === undefined) {
      return undefined;
    }
    const html = readFileSync(this.html, "utf8");
    const raw = (id: string): string | undefined => {
      const start = html.indexOf(`<script type="application/json" id="${id}">`);
      if (start === -1) {
        return undefined;
      }
      const from = html.indexOf(">", start) + 1;
      return html.slice(from, html.indexOf("</script>", from));
    };
    const payload = raw(review.block);
    if (payload === undefined) {
      return undefined;
    }
    const blocks = (JSON.parse(payload) as { images?: Record<string, { block: string }> }).images ?? {};
    const images: Record<string, string> = {};
    for (const { block } of Object.values(blocks)) {
      const content = block === "" ? undefined : raw(block);
      if (content !== undefined) {
        images[block] = content;
      }
    }
    return { review, payload, images };
  }

  /** a commit's stop never changes, so it is worked out once */
  #commitStops = new Map<string, ReviewStop>();

  /**
   * the stops of the review's commit bar now: each commit of the branch
   * since its base, then - when the checkout is this review - what is staged
   * and what is only in the working tree, each listed only while it has
   * something in it. Only for a review that follows its branch; a review
   * authored commit by commit has its own bar
   */
  stops(store: ReviewStore, onDisk: boolean): ReviewStop[] | undefined {
    if (store.baseRef === undefined || store.perCommit || this.#recipe === undefined) {
      return undefined;
    }
    const stops: ReviewStop[] = [];
    const range = store.head === undefined ? "" : (gitOut(this.repo, "rev-list", "--reverse", `${store.baseSha}..${store.head}`) ?? "");
    for (const sha of range.split("\n").filter((line) => line !== "")) {
      const known = this.#commitStops.get(sha);
      if (known !== undefined) {
        stops.push(known);
        continue;
      }
      const [short = "", subject = ""] = (gitOut(this.repo, "log", "-1", "--format=%h%x00%s", sha) ?? "").split("\u0000");
      const stop: ReviewStop = {
        key: sha,
        label: short,
        subject,
        refs: { before: nameOfCommit(this.repo, `${sha}^`), after: nameOfCommit(this.repo, sha) },
        files: parseNameStatus(gitOut(this.repo, "show", "--format=", "--name-status", "-M", sha) ?? ""),
      };
      this.#commitStops.set(sha, stop);
      stops.push(stop);
    }
    if (onDisk) {
      // each file's content id, so the page can tell when a stop's files changed
      // without fetching them: the blob staged, or a hash of the disk
      const staged = parseNameStatus(gitOut(this.repo, "diff", "--cached", "--name-status", "-M") ?? "").map(
        (file) => ({ ...file, sha: gitOut(this.repo, "rev-parse", `:${file.path}`) ?? "" }),
      );
      const working = [
        ...parseNameStatus(gitOut(this.repo, "diff", "--name-status", "-M") ?? ""),
        ...untrackedFiles(this.repo),
      ].map((file) => ({ ...file, sha: sha256(ReviewStore.read(join(this.repo, file.path))) }));
      const head = nameOfCommit(this.repo, "HEAD");
      if (staged.length > 0) {
        stops.push({
          key: stagedRef,
          label: "staged",
          subject: "in the index, not committed",
          refs: { before: head, after: { name: "index", sha: "" } },
          files: staged,
        });
      }
      if (working.length > 0) {
        stops.push({
          key: workingRef,
          label: "working",
          subject: "in the working tree, not staged",
          refs: { before: { name: "index", sha: "" }, after: { name: "working tree", sha: "" } },
          files: working,
        });
      }
    }
    return stops;
  }

  /** a stop's files, both sides and their counts: a commit against its
      parent, the index against HEAD, the disk against the index */
  stopSides(
    stop: string,
    files: { path: string; from?: string }[],
  ): Record<string, { before: string; after: string; sha: string; added: number; removed: number }> {
    const sides: ReturnType<ReviewPage["stopSides"]> = {};
    for (const { path, from } of files) {
      this.resolveInRepo(path);
      const was = from ?? path;
      const paths = from === undefined ? [path] : [from, path];
      let before: string;
      let after: string;
      let numstat: string;
      if (stop === stagedRef) {
        before = this.#show(`HEAD:${was}`);
        after = this.#show(`:${path}`);
        numstat = gitOut(this.repo, "diff", "--cached", "--numstat", "-M", "--", ...paths) ?? "";
      } else if (stop === workingRef) {
        before = this.#show(`:${was}`);
        after = ReviewStore.read(this.resolveInRepo(path));
        numstat = gitOut(this.repo, "diff", "--numstat", "-M", "--", ...paths) ?? "";
      } else {
        before = this.#show(`${stop}^:${was}`);
        after = this.#show(`${stop}:${path}`);
        numstat = gitOut(this.repo, "diff", "--numstat", "-M", `${stop}^`, stop, "--", ...paths) ?? "";
      }
      const [added, removed] = numstat.split(/\s+/);
      const counted = added !== undefined && /^\d+$/.test(added) && removed !== undefined;
      sides[path] = {
        before,
        after,
        sha: sha256(after),
        // an untracked file has no diff for git to count: all of it is new
        added: counted ? Number(added) : after.split("\n").filter((line, index, all) => index < all.length - 1 || line !== "").length,
        removed: counted ? Number(removed) : 0,
      };
    }
    return sides;
  }

  /** the files the review's scope covers now, for the page to show any that
      came into it since the review was written - measured from the current
      base to the disk when the checkout is this review, or to its head */
  scopeNow(store: ReviewStore, onDisk: boolean): ScopeFile[] | undefined {
    if (store.baseRef === undefined || store.perCommit) {
      return undefined;
    }
    const scope = scopeFiles(this.repo, store.baseSha, onDisk ? undefined : store.head);
    store.announceScope(scope);
    return scope;
  }

  /** a file as it is at the review's current base - followed from where it
      was then, for a file the review shows renamed - and its line counts
      against what the page's after side is: the disk when the checkout is
      this review, the head otherwise */
  before(
    store: ReviewStore,
    path: string,
    from: string | undefined,
    onDisk: boolean,
  ): { before: string; after: string; sha: string; added: number; removed: number } {
    const base = store.baseSha;
    const was = from ?? path;
    const before = this.#show(`${base}:${was}`);
    const after = onDisk ? [] : [store.head ?? "HEAD"];
    const paths = from === undefined ? [path] : [from, path];
    const numstat = gitOut(this.repo, "diff", "--numstat", "-M", base, ...after, "--", ...paths) ?? "";
    const [added, removed] = numstat.split(/\s+/);
    const current = onDisk ? ReviewStore.read(this.resolveInRepo(path)) : this.#show(`${store.head ?? "HEAD"}:${path}`);
    return {
      before,
      after: current,
      sha: sha256(current),
      ...(added !== undefined && /^\d+$/.test(added) && removed !== undefined ?
        { added: Number(added), removed: Number(removed) }
      : onDisk ? this.lineCounts(path, base)
      : { added: 0, removed: 0 }),
    };
  }

  /** a blob's content as is (not trimmed, as gitOut's is), or empty where
      the path didn't exist at that commit */
  #show(spec: string): string {
    try {
      return execFileSync("git", ["show", spec], {
        cwd: this.repo,
        encoding: "utf8",
        maxBuffer: 512 * 1_024 * 1_024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  }

  page(): string {
    const { reviewId, reason } = this.editable();
    const bootstrap = `<script>window.__reviewServer = ${JSON.stringify({
      token: this.token,
      editableReviewId: reviewId,
      ...(reason === undefined ? {} : { readOnlyReason: reason }),
    })};</script>`;
    const text = readFileSync(this.html, "utf8");
    if (!text.includes(marker)) {
      throw new Error(`${this.html} has no ${marker} - rebuild it with the current build.ts`);
    }
    return text.replace(marker, bootstrap);
  }

  /** a path inside the repo, or an error - never a traversal or a symlink out */
  resolveInRepo(path: string): string {
    const candidate = resolve(this.repo, path);
    const inside = relative(this.repo, candidate);
    if (inside.startsWith("..") || inside === "") {
      throw new Error(`${path} is outside the repo`);
    }
    return candidate;
  }

  /** always against the review's own base commit, never the working
      checkout's index - a file already committed on this branch (eg one this
      review itself adds) is a normal, whole-file addition measured from
      there. A path never committed at all - a fresh worktree-mode addition -
      is invisible to `git diff <ref>` regardless of the ref, so that one
      case alone still falls back to diffing it against nothing */
  lineCounts(path: string, reviewBaseSha: string): { added: number; removed: number } {
    const run = (...args: string[]): string => {
      try {
        return execFileSync("git", args, {
          cwd: this.repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (error) {
        const failure = error as { stdout?: string };
        return failure.stdout ?? "";
      }
    };

    const tracked = run("ls-files", "--error-unmatch", "--", path).trim() !== "";
    const numstat =
      tracked ?
        run("diff", "--numstat", reviewBaseSha, "--", path)
      : run("diff", "--numstat", "--no-index", "--", "/dev/null", path);

    const [added, removed] = numstat.split(/\s+/);
    return added !== undefined && /^\d+$/.test(added) && removed !== undefined ?
        { added: Number(added), removed: Number(removed) }
      : { added: 0, removed: 0 };
  }

  save(
    path: string,
    content: string,
    baseSha: string,
    reviewBaseSha: string,
  ): { sha: string; added: number; removed: number } {
    const target = this.resolveInRepo(path);
    if (sha256(ReviewStore.read(target)) !== baseSha) {
      throw Object.assign(
        new Error(`${path} changed on disk since this review was built`),
        { conflict: true },
      );
    }
    writeFileSync(target, content, "utf8");
    return { sha: sha256(content), ...this.lineCounts(path, reviewBaseSha) };
  }

  /** what the page needs to notice that a file changed under it: just the
      sha, hashed straight from disk with no git subprocess - the poll asks
      about every tracked path every tick, so this has to stay cheap
      regardless of how large the review is. Line counts are only ever
      wanted for a path whose sha has actually moved, which goes through
      fileContent() instead - never for the bulk poll */
  fileState(paths: string[]): Record<string, string> {
    const state: Record<string, string> = {};
    for (const path of paths) {
      try {
        state[path] = sha256(ReviewStore.read(this.resolveInRepo(path)));
      } catch {
        // outside the repo: not this review's file to report on
      }
    }
    return state;
  }

  fileContent(
    path: string,
    reviewBaseSha: string,
  ): { after: string; sha: string; added: number; removed: number } {
    const content = ReviewStore.read(this.resolveInRepo(path));
    return { after: content, sha: sha256(content), ...this.lineCounts(path, reviewBaseSha) };
  }
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
};

const respondJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  response.end(body);
};

const handleGet = (
  reviewPage: ReviewPage,
  path: string,
  store: ReviewStore | undefined,
  response: ServerResponse,
): void => {
  if (path === "/favicon.ico") {
    // the browser asks unprompted; a 404 would put an error in the console of
    // every review for something the page never wanted
    response.writeHead(204).end();
    return;
  }
  if (path.startsWith("/vs/")) {
    serveMonaco(path, response);
    return;
  }
  if (path === "/" || path === "/index.html") {
    const body = Buffer.from(reviewPage.page(), "utf8");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
    });
    response.end(body);
    return;
  }
  if (path === "/notes") {
    if (store === undefined) {
      respondJson(response, 404, { error: "unknown review" });
      return;
    }
    respondJson(response, 200, store.readNotes());
    return;
  }
  if (path === "/github") {
    if (store === undefined) {
      respondJson(response, 404, { error: "unknown review" });
      return;
    }
    respondJson(response, 200, store.readGithub() ?? null);
    return;
  }
  if (path === "/payload") {
    const built = store === undefined ? undefined : reviewPage.built(store);
    if (built === undefined) {
      respondJson(response, 404, { error: "unknown review" });
      return;
    }
    // the blocks go back as the page carries them, escaped json text
    respondJson(response, 200, built);
    return;
  }
  if (path === "/ticks") {
    if (store === undefined) {
      respondJson(response, 404, { error: "unknown review" });
      return;
    }
    respondJson(response, 200, { ticked: store.readTicks() });
    return;
  }
  respondJson(response, 404, { error: "not found" });
};

const handlePost = (
  reviewPage: ReviewPage,
  path: string,
  store: ReviewStore | undefined,
  body: Record<string, unknown>,
  response: ServerResponse,
): void => {
  if (store === undefined) {
    respondJson(response, 404, { error: "unknown review" });
    return;
  }
  // writing to the working tree is only for the review whose branch is
  // actually checked out there
  const editable = store.id === reviewPage.editableReviewId();

  if (path === "/save") {
    if (!editable) {
      respondJson(response, 403, {
        error: "this review's branch is not the served checkout - nothing to save into",
      });
      return;
    }
    try {
      const result = reviewPage.save(
        body.path as string,
        body.content as string,
        body.sha as string,
        store.baseSha,
      );
      console.log(`  saved ${body.path as string}`);
      respondJson(response, 200, result);
    } catch (error) {
      const failed = error as Error & { conflict?: boolean };
      respondJson(response, failed.conflict === true ? 409 : 400, { error: failed.message });
    }
    return;
  }
  if (path === "/notes") {
    store.writeNotes(body as Notes);
    respondJson(response, 200, { ok: true });
    return;
  }
  if (path === "/ticks") {
    store.writeTicks((body.ticked as string[]) ?? []);
    respondJson(response, 200, { ok: true });
    return;
  }
  if (path === "/handoff") {
    respondJson(response, 200, { count: store.handOff(body as Notes) });
    return;
  }
  if (path === "/state") {
    // the page's poll: threads, and whether the files it has open have moved
    // under it (an agent acting on a note) - the latter only for the review
    // the checkout can actually change. And whether the branch has moved
    // since the page was built, which starts a rebuild
    reviewPage.maybeRebuild(store);
    respondJson(response, 200, {
      notes: store.readNotes(),
      ticked: store.readTicks(),
      github: store.readGithub() ?? null,
      files: editable ? reviewPage.fileState((body.paths as string[]) ?? []) : {},
      // what the page now being served was built at - a page built at
      // something else takes the new build in
      build: {
        baseSha: store.baseSha,
        headSha: store.headSha ?? null,
        rebuilding: store.rebuilding,
        movedBecause: store.movedBecause,
        failure: store.failure,
      },
      // the files the scope covers now - the page adds any that came into
      // it since the review was written
      scope: reviewPage.scopeNow(store, editable) ?? null,
      // the commit bar's stops: the branch's commits, staged, working
      stops: reviewPage.stops(store, editable) ?? null,
    });
    return;
  }
  /* answering a PR comment from the page: the reply is posted to the forge as
     whoever `gh` is signed in as, so it only ever happens on a deliberate
     click - and the fresh state goes straight back, so the thread shows the
     reply without waiting for prComments.ts to come round again */
  if (path === "/github-reply") {
    const pr = Number(body.pr);
    const text = String(body.body ?? "");
    if (!Number.isInteger(pr) || text.trim() === "") {
      respondJson(response, 400, { error: "a reply needs a pr and something to say" });
      return;
    }
    try {
      if (body.replyTo === undefined) {
        commentOnPr(reviewPage.repo, pr, text);
        console.log(`  commented on #${pr}`);
      } else {
        replyToThread(reviewPage.repo, pr, Number(body.replyTo), text);
        console.log(`  replied on #${pr} thread ${String(body.replyTo)}`);
      }
      const fresh = fetchPrComments(reviewPage.repo, pr);
      writeFileSync(store.githubFile, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
      respondJson(response, 200, fresh);
    } catch (error) {
      respondJson(response, 502, { error: (error as Error).message.split("\n")[0] });
    }
    return;
  }
  if (path === "/stop-sides") {
    try {
      respondJson(
        response,
        200,
        reviewPage.stopSides(String(body.stop ?? ""), (body.files as { path: string; from?: string }[]) ?? []),
      );
    } catch (error) {
      respondJson(response, 400, { error: (error as Error).message });
    }
    return;
  }
  if (path === "/before") {
    const files = (body.files as { path: string; from?: string }[] | undefined) ?? [];
    const result: Record<string, ReturnType<ReviewPage["before"]>> = {};
    for (const file of files) {
      try {
        reviewPage.resolveInRepo(file.path);
        result[file.path] = reviewPage.before(store, file.path, file.from, editable);
      } catch {
        // outside the repo: not this review's file to read
      }
    }
    respondJson(response, 200, { base: store.baseSha, files: result });
    return;
  }
  if (path === "/file") {
    if (!editable) {
      respondJson(response, 403, {
        error: "this review's branch is not the served checkout",
      });
      return;
    }
    respondJson(response, 200, reviewPage.fileContent(body.path as string, store.baseSha));
    return;
  }
  respondJson(response, 404, { error: "not found" });
};

const options = parseOptions();
const reviewPage = new ReviewPage(options.html, options.repo);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const store = reviewPage.store(url.searchParams.get("review"));

  // /state is polled every couple of seconds, and monaco is dozens of asset
  // requests; logging them buries everything else
  if (!["/notes", "/ticks", "/state", "/favicon.ico"].includes(path) && !path.startsWith("/vs/")) {
    console.log(`  ${request.method ?? "?"} ${path}`);
  }

  if (request.method === "GET") {
    handleGet(reviewPage, path, store, response);
    return;
  }
  if (request.method !== "POST") {
    respondJson(response, 405, { error: "method not allowed" });
    return;
  }

  // the body has to come off the socket before anything else can be answered -
  // refusing a request without draining it leaves the next one on this
  // keep-alive connection to be parsed starting halfway through this one's json
  readBody(request).then((raw) => {
    if (request.headers["x-review-token"] !== reviewPage.token) {
      // a page left open across a restart of this server holds a token that no
      // longer exists; it needs to reload, not retry
      respondJson(response, 403, { error: "stale token - reload the page" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
    } catch (malformed) {
      respondJson(response, 400, { error: `unreadable body: ${(malformed as Error).message}` });
      return;
    }
    handlePost(reviewPage, path, store, body, response);
  });
});

server.listen(options.port, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  const url = `http://127.0.0.1:${port}/`;

  console.log(`guided review on ${url}`);
  console.log(`  editing ${reviewPage.repo}`);
  const editableId = reviewPage.editableReviewId();
  for (const store of reviewPage.stores()) {
    const marker2 = store.id === editableId ? " (editable - matches the checkout)" : "";
    console.log(`  ${store.label === "" ? "review" : store.label}  ${store.notesMarkdown}${marker2}`);
  }
  console.log("  notes appear below as they are written; 'Send notes to agent' prints them all");
  console.log("  ctrl-c to stop");

  if (options.open) {
    const opener =
      process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    execFileSync(opener, [url]);
  }
});
