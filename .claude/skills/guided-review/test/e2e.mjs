// End-to-end checks of a served guided review, in headless Chromium, against
// throwaway repos: each scenario makes its own repo, builds a review of it,
// serves it on a spare port, drives the page the way a reader would - and
// edits, stages, commits and rebases under it - then stops its server.
//
//   pnpm test:e2e            # every scenario
//   pnpm test:e2e G H        # just these
//
// Needs Chromium for Playwright, once: pnpm exec playwright install chromium
//
// Scenario E reviews a real, large branch (a clone of it, never the original):
//   GR_E2E_BIG_REPO=<a checkout>  [GR_E2E_BIG_BRANCH=<branch>]  [GR_E2E_BIG_BASE=origin/main]
// and is skipped without one.
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SKILL = process.env.GR_SKILL ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIG = process.env.GR_E2E_BIG_REPO;
// everything a run makes - repos, pages, review stores - lives here, outside the skill
const ROOT = mkdtempSync(join(tmpdir(), "guided-review-e2e-"));
const only = process.argv.slice(2);

const results = [];
const check = (scenario, name, ok, detail = "") => {
  results.push({ scenario, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${scenario}] ${name}${detail === "" ? "" : `  — ${detail}`}`);
};

const sh = (cmd, cwd, env = {}) =>
  execSync(cmd, { cwd, stdio: "pipe", env: { ...process.env, GIT_EDITOR: "true", ...env } }).toString();

const fresh = (name) => {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

const gitInit = (dir) => sh("git init -q -b main && git config user.email t@t && git config user.name t", dir);

const write = (dir, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
};

/** an edit to a file, made the way a one-line sed substitution would make it -
    literally, the first match on each line - or every match, for a rename */
const swap = (repo, file, from, to, every = false) => {
  const path = join(repo, file);
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    every ? text.split(from).join(to) : text.split("\n").map((line) => line.replace(from, to)).join("\n"),
  );
};

const build = (repo, name, groups, args) => {
  const groupsFile = join(ROOT, `${name}.json`);
  writeFileSync(groupsFile, JSON.stringify(groups));
  const html = join(ROOT, `${name}.html`);
  const started = Date.now();
  const out = sh(`node ${SKILL}/build.ts --groups ${groupsFile} --out ${html} --repo . --github none ${args}`, repo);
  return { html, out, ms: Date.now() - started };
};

const servers = [];
const serve = async (repo, html) => {
  const proc = spawn(process.execPath, [`${SKILL}/serve.ts`, "--html", html, "--repo", ".", "--port", "0"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (chunk) => (log += chunk));
  proc.stderr.on("data", (chunk) => (log += chunk));
  for (let i = 0; i < 100 && !/127\.0\.0\.1:\d+/.test(log); i++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  const port = /127\.0\.0\.1:(\d+)/.exec(log)?.[1];
  servers.push(proc);
  return { port, log: () => log, stop: () => proc.kill() };
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** waits for fn() (in node) to be truthy */
const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  return undefined;
};

let browser;
const open = async (port, scheme = "dark") => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|404/.test(message.text())) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector(".row");
  await sleep(800);
  return { page, errors };
};

const toasts = (page) => page.locator(".toast").allInnerTexts();

const rowInfo = (page, path) =>
  page.evaluate((path) => {
    const row = document.querySelector(`.row[data-path="${path}"]`);
    if (row === null) return null;
    return {
      ticked: row.querySelector("input.tick").checked,
      chips: [...row.querySelectorAll(".row-head .chip")].map((chip) => chip.textContent.trim()),
      stat: row.querySelector(".row-stat")?.textContent.replace(/\s+/g, " ").trim(),
      movedLabels: [...row.querySelectorAll(".moved-label")].map((label) => label.textContent.replace(/\s+/g, " ").trim()),
      hint: row.querySelector(".editor-bar .hint")?.textContent,
      status: row.querySelector(".editor-bar span:nth-child(2)")?.textContent,
      renamedFrom: row.querySelector(".renamed-from")?.textContent.replace(/\s+/g, " ").trim(),
      editorHref: row.querySelector("a.open-in-editor")?.getAttribute("href"),
    };
  }, path);

/** a monaco model's content - its uri carries the row's key, encoded */
const model = (page, which, key) =>
  page.evaluate(
    ([which, key]) =>
      window.monaco?.editor
        .getModels()
        .find((m) => decodeURIComponent(m.uri.toString()) === `inmemory://review/${which}/${key}`)
        ?.getValue(),
    [which, key],
  );

const editorFor = (key) => (wanted) =>
  window.monaco.editor
    .getEditors()
    .find((e) => decodeURIComponent(e.getModel()?.uri.toString() ?? "") === `inmemory://review/modified/${wanted}`);

const openDiff = async (page, path) => {
  const toggle = page.locator(`.row[data-path="${path}"] .diff-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await until(() => model(page, "modified", path));
};

const untickAll = async (page) => {
  for (const box of await page.locator(".row input.tick:checked").all()) await box.uncheck();
  await sleep(300);
};

const rowsOf = (page) => page.locator(".row").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-path")));

const shellOf = (html) =>
  JSON.parse(readFileSync(html, "utf8").match(/id="shell">([\s\S]*?)<\/script>/)[1]).reviews;

/* ---- A: an editable PR review through commits and a rebase --------------- */
const scenarioA = async () => {
  const S = "A";
  const repo = fresh("repo-a");
  gitInit(repo);
  const longFile = Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
  write(repo, {
    "a.ts": "const one = 1;\nconst two = 2;\nconst three = 3;\n",
    "b.ts": longFile,
    "x.ts":
      "export const keep = 1;\n\nexport const distance = (ax: number, ay: number, bx: number, by: number): number => {\n  const dx = ax - bx;\n  const dy = ay - by;\n  return Math.sqrt(dx * dx + dy * dy);\n};\n",
    "old/name.ts": "export const renamed = 'same';\nexport const other = 'thing';\nexport const third = 'more';\n",
  });
  sh("git add . && git commit -qm base", repo);
  sh("git checkout -qb feature", repo);
  write(repo, {
    "y.ts":
      "export const distance = (ax: number, ay: number, bx: number, by: number): number => {\n  const dx = ax - bx;\n  const dy = ay - by;\n  return Math.sqrt(dx * dx + dy * dy);\n};\n",
    "x.ts": "export const keep = 1;\n",
  });
  swap(repo, "a.ts", "three = 3", "three = 33");
  swap(repo, "b.ts", "line30 = 30", "line30 = 3030");
  sh("mkdir -p new && git mv old/name.ts new/name.ts", repo);
  swap(repo, "new/name.ts", "'more'", "'more!'");
  sh("git add . && git commit -qm 'feature work'", repo);

  const { html } = build(
    repo,
    "a",
    {
      meta: { title: "scenario A" },
      groups: [
        { title: "Moved", items: [{ path: "x.ts", status: "M" }, { path: "y.ts", status: "A" }] },
        { title: "Edited", items: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "M" }, { path: "new/name.ts", status: "R" }] },
      ],
    },
    "--mode pr --base main --head HEAD",
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  await untickAll(page);

  // earlier features, on a fresh page
  const renamed = await rowInfo(page, "new/name.ts");
  check(S, "renamed row says where from", renamed?.renamedFrom?.includes("old/name.ts"), renamed?.renamedFrom);
  check(S, "renamed row counts only the edit", renamed?.stat?.startsWith("+1 −1"), renamed?.stat);
  for (const path of ["y.ts", "x.ts", "a.ts", "b.ts"]) await openDiff(page, path);
  const refsLine = await page.locator('.row[data-path="y.ts"] .diff-refs').innerText().catch(() => "");
  const headShort = sh("git rev-parse --short=7 HEAD", repo).trim();
  check(S, "the diff says what it is between", /^diff main \(\w{7}\) → feature \(\w{7}\) \+ working tree$/.test(refsLine.trim()) && refsLine.includes(headShort), refsLine);
  const y = await rowInfo(page, "y.ts");
  check(S, "moved box on the extracted function", y?.movedLabels?.[0]?.includes("moved here from x.ts:3"), y?.movedLabels?.[0]);
  check(S, "editable PR review says so", y?.hint?.startsWith("editable"), y?.hint);

  await page.locator('.row[data-path="y.ts"] button.moved-link').click();
  await sleep(800);
  const activeTree = await page.locator(".tree-file.is-active .tree-base").innerText().catch(() => "");
  check(S, "moved-from link goes to the other file", activeTree === "x.ts", activeTree);

  const before = (await rowInfo(page, "a.ts"))?.editorHref ?? "";
  await page.locator(".editor-picker select").selectOption("cursor");
  await sleep(300);
  const after = (await rowInfo(page, "a.ts"))?.editorHref ?? "";
  check(S, "IDE picker changes the file links", before.startsWith("vscode://") && after.startsWith("cursor://"), `${before.slice(0, 20)} → ${after.slice(0, 20)}`);
  await page.locator(".editor-picker select").selectOption("vscode");

  sh("printf 'export const added = true;\\n' >> b.ts", repo);
  const synced = await until(async () => (await model(page, "modified", "b.ts"))?.includes("added = true"));
  check(S, "an uncommitted edit on disk shows in the diff", synced === true);
  await page.locator('.row[data-path="b.ts"] input.tick').check();
  await sleep(500);

  // an unsaved edit: saves are held back so it stays unsaved
  await page.route("**/save?**", () => {});
  await page.evaluate(() => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => decodeURIComponent(e.getModel()?.uri.toString() ?? "") === "inmemory://review/modified/a.ts");
    editor.executeEdits("test", [{ range: new window.monaco.Range(1, 1, 1, 1), text: "// unsaved thought\n" }]);
  });
  await sleep(1200);
  const unsavedBefore = await rowInfo(page, "a.ts");
  check(S, "an edit held back from saving shows as unsaved", /unsaved|saving/.test(unsavedBefore?.status ?? ""), unsavedBefore?.status);

  await page.locator('.row[data-path="b.ts"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  await sleep(500);
  const scrollBefore = await page.evaluate(() => window.scrollY);

  // 1. a commit of an unrelated file - the head moves, the review rebuilds
  write(repo, { "c.ts": "export const c = 'committed after the build';\n" });
  sh("git add c.ts && git commit -qm 'add c'", repo);
  const rebuilt1 = await until(async () => (await toasts(page)).some((t) => t.includes("rebuilt")), 30_000);
  check(S, "a commit rebuilds the review, and the page says so", rebuilt1 === true);
  check(S, "server logged the rebuild", /rebuilt the review at/.test(server.log()));
  const headNow = sh("git rev-parse HEAD", repo).trim();
  check(S, "the html on disk is the new build", shellOf(html)[0].headSha === headNow);

  const b = await rowInfo(page, "b.ts");
  const bModel = await model(page, "modified", "b.ts");
  check(S, "uncommitted edit kept through the rebuild", bModel?.includes("added = true") === true);
  check(S, "a read file the rebuild didn't change stays read", b?.ticked === true && !b.chips.includes("Changed since read"), JSON.stringify(b?.chips));
  check(S, "counts include the uncommitted edit", b?.stat?.startsWith("+2 −1"), b?.stat);
  const aModel = await model(page, "modified", "a.ts");
  const a = await rowInfo(page, "a.ts");
  check(S, "unsaved edit kept through the rebuild", aModel?.startsWith("// unsaved thought") === true);
  check(S, "...and still marked unsaved", /unsaved|saving/.test(a?.status ?? ""), a?.status);
  const scrollAfter = await page.evaluate(() => window.scrollY);
  check(S, "scroll position kept through the rebuild", Math.abs(scrollAfter - scrollBefore) < 60, `${scrollBefore} → ${scrollAfter}`);
  const c = await until(async () => (await rowInfo(page, "c.ts")) ?? undefined, 6000);
  check(S, "the committed new file is in the live chapter", c !== undefined, JSON.stringify(await rowsOf(page)));
  await page.unroute("**/save?**");
  await sleep(1500);
  sh("git checkout -q -- a.ts", repo);
  await sleep(2500);

  // 2. a rebase onto a moved main, with uncommitted work
  sh("git stash -q -u -m harness && git checkout -q main", repo);
  swap(repo, "a.ts", "one = 1", "one = 111");
  sh("git commit -qam 'main moves' && git checkout -q feature && git rebase -q main && git stash pop -q", repo);
  const rebuilt2 = await until(async () => (await model(page, "original", "a.ts"))?.includes("one = 111"), 30_000);
  check(S, "a rebase rebuilds: the before side is the new main", rebuilt2 === true);
  const y2 = await rowInfo(page, "y.ts");
  check(S, "moved box survives the rebase", y2?.movedLabels?.[0]?.includes("moved here from x.ts:3"), y2?.movedLabels?.[0]);
  const a2 = await rowInfo(page, "a.ts");
  check(S, "a file whose before side moved isn't 'read' any more", a2?.ticked === false);
  const b2 = await model(page, "modified", "b.ts");
  check(S, "uncommitted edit kept through the rebase", b2?.includes("added = true") === true);

  // notes: waiting, then answered - the speech bubble
  const id = shellOf(html)[0].reviewId;
  const token = readFileSync(join(ROOT, id, "token"), "utf8").trim();
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${server.port}${path}?review=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Review-Token": token },
      body: JSON.stringify(body),
    });
  await post("/notes", { "y.ts": [{ line: 1, messages: [{ from: "reviewer", text: "why move it?" }] }] });
  const waiting = await until(() => page.locator(".tree-file .note-bubble.is-waiting").count());
  check(S, "a note waiting on the agent: outline bubble", waiting === 1);
  await post("/notes", {
    "y.ts": [{ line: 1, messages: [{ from: "reviewer", text: "why move it?" }, { from: "agent", text: "to share it" }] }],
  });
  const answered = await until(() => page.locator(".tree-file .note-bubble.is-answered").count());
  check(S, "the agent answered: filled bubble", answered === 1);
  check(S, "the note shows in the diff", (await page.locator('.row[data-path="y.ts"] .note-zone').count()) >= 1);

  sh("git stash -q -u -m harness2 && git checkout -q main", repo);
  const other = (await open(server.port)).page;
  await other.locator('.row[data-path="a.ts"] .diff-toggle').click().catch(() => {});
  await sleep(1500);
  const hint = await other.locator(".editor-bar .hint").first().innerText().catch(() => "");
  check(S, "on another branch the editors hold their edits, rather than save to disk", hint.includes("edits are held on top of this PR"), hint);
  await other.close();
  sh("git checkout -q feature && git stash pop -q", repo);

  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- B: a rebase that stops on a conflict --------------------------------- */
const scenarioB = async () => {
  const S = "B";
  const repo = fresh("repo-b");
  gitInit(repo);
  write(repo, { "a.ts": "const one = 1;\nconst two = 2;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "a.ts", "one = 1", "one = 10");
  sh("git commit -qam feature", repo);
  const { html } = build(repo, "b", { meta: { title: "B" }, groups: [{ title: "x", items: [{ path: "a.ts", status: "M" }] }] }, "--mode pr --base main --head HEAD");
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  sh("git checkout -q main", repo);
  swap(repo, "a.ts", "one = 1", "one = 99");
  sh("git commit -qam 'main conflicts' && git checkout -q feature", repo);
  try {
    sh("git rebase -q main", repo);
  } catch {
    /* stops on the conflict, as intended */
  }
  check(S, "the rebase is stopped on a conflict", existsSync(join(repo, ".git", "rebase-merge")));
  await sleep(6000);
  check(S, "no rebuild while the rebase is stopped", !/rebuilding the review/.test(server.log()));
  write(repo, { "a.ts": "const one = 1099;\nconst two = 2;\n" });
  sh("git add a.ts && git rebase --continue", repo);
  const rebuilt = await until(async () => (await toasts(page)).some((t) => t.includes("rebuilt")), 30_000);
  check(S, "once the rebase finishes, the review rebuilds", rebuilt === true);
  check(S, "no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
  server.stop();
};

/* ---- C: a rebuild that fails ------------------------------------------- */
const scenarioC = async () => {
  const S = "C";
  const repo = fresh("repo-c");
  gitInit(repo);
  write(repo, { "a.ts": "const one = 1;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "a.ts", "one = 1", "one = 10");
  sh("git commit -qam feature", repo);
  const { html } = build(repo, "c", { meta: { title: "C" }, groups: [{ title: "x", items: [{ path: "a.ts", status: "M" }] }] }, "--mode pr --base main --head HEAD");
  const server = await serve(repo, html);
  const { page } = await open(server.port);
  sh("git branch -m main gone && printf 'more\\n' > b.txt && git add b.txt && git commit -qm more", repo);
  const warned = await until(async () => (await toasts(page)).some((t) => t.includes("couldn't rebuild")), 30_000);
  check(S, "a failed rebuild is reported in the page", warned === true, (await toasts(page)).join(" | "));
  await sleep(6000);
  const attempts = (server.log().match(/rebuilding the review$/gm) ?? []).length;
  check(S, "a failed rebuild isn't retried in a loop", attempts === 1, `${attempts} attempts`);
  check(S, "the old build still serves", (await rowInfo(page, "a.ts")) !== null);
  await page.close();
  server.stop();
};

/* ---- D: a working-tree review, then a commit ----------------------------- */
const scenarioD = async () => {
  const S = "D";
  const repo = fresh("repo-d");
  gitInit(repo);
  write(repo, { "a.ts": "const one = 1;\nconst two = 2;\n" });
  sh("git add . && git commit -qm base", repo);
  swap(repo, "a.ts", "two = 2", "two = 22");
  const { html } = build(repo, "d", { meta: { title: "D" }, groups: [{ title: "x", items: [{ path: "a.ts", status: "M" }] }] }, "--mode worktree");
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  await openDiff(page, "a.ts");
  const first = await rowInfo(page, "a.ts");
  check(S, "working-tree review counts the uncommitted edit", first?.stat?.startsWith("+1 −1"), first?.stat);
  sh("git commit -qam 'commit the work'", repo);
  const rebuilt = await until(async () => (await toasts(page)).some((t) => t.includes("rebuilt")), 30_000);
  check(S, "a commit rebuilds a working-tree review", rebuilt === true);
  // nothing uncommitted is left, so the file drops out of the review
  const gone = await until(async () => !(await rowsOf(page)).includes("a.ts"));
  check(S, "after the commit, the file with nothing uncommitted drops out", gone === true, JSON.stringify(await rowsOf(page)));
  check(S, "no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
  server.stop();
};

/* ---- E: a real-sized review (a throwaway clone of a big branch) -------- */
const scenarioE = async () => {
  const S = "E";
  if (BIG === undefined) {
    console.log("skip  [E] set GR_E2E_BIG_REPO to a checkout with a big branch to review");
    return;
  }
  const branch = process.env.GR_E2E_BIG_BRANCH ?? sh("git rev-parse --abbrev-ref HEAD", BIG).trim();
  const base = process.env.GR_E2E_BIG_BASE ?? "origin/main";
  const repo = join(ROOT, "repo-e");
  sh(`git clone -q --branch ${branch} ${BIG} ${repo}`, ROOT);
  sh("git config user.email t@t && git config user.name t", repo);
  const listing = sh(`${SKILL}/changedFiles.sh pr ${base} HEAD`, repo)
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  const items = listing.map(([status, ...paths]) => ({ path: paths[paths.length - 1], status: status.charAt(0) }));
  const { html, ms } = build(repo, "e", { meta: { title: "E" }, groups: [{ title: "Everything", items }] }, `--mode pr --base ${base} --head HEAD`);
  check(S, "builds", true, `${items.length} files, ${Math.round(ms / 1000)}s`);
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  const rows = await page.locator(".row").count();
  check(S, "page loads every row", rows === items.length, `${rows} rows`);
  // a commit on the clone: time the rebuild while the page polls
  const touched = items.find((item) => item.status !== "D" && existsSync(join(repo, item.path)));
  writeFileSync(join(repo, touched.path), `${readFileSync(join(repo, touched.path), "utf8")}\n// touched by the e2e run\n`);
  sh("git commit -qam 'touch'", repo);
  const started = Date.now();
  let polls = 0;
  page.on("request", (request) => request.url().includes("/state") && polls++);
  const rebuilt = await until(async () => (await toasts(page)).some((t) => t.includes("rebuilt")), 120_000);
  const took = Date.now() - started;
  check(S, "rebuilds after a commit", rebuilt === true, `${Math.round(took / 1000)}s`);
  check(S, "the page kept polling while it rebuilt", polls >= Math.floor(took / 2500), `${polls} polls in ${Math.round(took / 1000)}s`);
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- F: reviews that don't rebuild still work ---------------------------- */
const scenarioF = async () => {
  const S = "F";
  {
    const repo = fresh("repo-f1");
    gitInit(repo);
    write(repo, { "a.ts": "const one = 1;\n" });
    sh("git add . && git commit -qm base && git checkout -qb feature", repo);
    swap(repo, "a.ts", "one = 1", "one = 2");
    sh("git commit -qam first", repo);
    const first = sh("git rev-parse HEAD", repo).trim();
    swap(repo, "a.ts", "one = 2", "one = 3");
    sh("git commit -qam second", repo);
    const second = sh("git rev-parse HEAD", repo).trim();
    const { html } = build(
      repo,
      "f1",
      {
        meta: { title: "per commit" },
        commits: [
          { ref: first, groups: [{ title: "first", items: [{ path: "a.ts", status: "M" }] }] },
          { ref: second, groups: [{ title: "second", items: [{ path: "a.ts", status: "M" }] }] },
        ],
      },
      "--mode pr --base main --head HEAD",
    );
    check(S, "a per-commit review is rebuilt only when the page moves its branch", /"follow":false/.test(readFileSync(html, "utf8").match(/id="recipe">([^<]*)/)?.[1] ?? ""));
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    await page.locator(".row .diff-toggle").first().click();
    await sleep(2500);
    const hint = await page.locator(".editor-bar .hint").first().innerText().catch(() => "");
    check(S, "a commit's diff says its edits are held against it", hint.includes("edits are held against this commit"), hint);
    const commitRefs = await page.locator(".diff-refs").first().innerText().catch(() => "");
    check(S, "a commit's diff names its parent and itself", /^diff main \(\w{7}\) → feature~1 \(\w{7}\)$/.test(commitRefs.trim()), commitRefs);
    sh("printf 'x\\n' > z.txt && git add z.txt && git commit -qm later", repo);
    await sleep(5000);
    check(S, "per-commit review doesn't rebuild", !/rebuilding the review/.test(server.log()));
    check(S, "per-commit page: no errors", errors.length === 0, errors.join(" | "));
    await page.close();
    server.stop();
  }
  {
    const repo = join(ROOT, "repo-f2");
    rmSync(repo, { recursive: true, force: true });
    sh(`${SKILL}/fixtures/conflictRepo.sh ${repo} merge`, ROOT);
    const listing = sh(`${SKILL}/changedFiles.sh conflict`, repo)
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const { html } = build(
      repo,
      "f2",
      { meta: { title: "conflict" }, groups: [{ title: "x", items: listing.map(([status, path]) => ({ path, status: status.charAt(0) })) }] },
      "--mode conflict",
    );
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    await page.locator(".row .diff-toggle").first().click();
    await sleep(3000);
    const panes = await page.locator(".three-way-head").count();
    check(S, "conflict review opens its 3-way view", panes >= 1, `${panes} heads`);
    check(S, "conflict page: no errors", errors.length === 0, errors.join(" | "));
    await page.close();
    server.stop();
  }
  {
    const repo = join(ROOT, "repo-f3");
    rmSync(repo, { recursive: true, force: true });
    sh(`${SKILL}/fixtures/localStack.sh ${repo}`, ROOT);
    sh("git checkout -q api", repo);
    const stackJson = join(ROOT, "f3-stack.json");
    writeFileSync(stackJson, sh(`node ${SKILL}/resolveStack.ts --stack`, repo));
    const files = sh(`${SKILL}/changedFiles.sh pr auth api`, repo)
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const { html } = build(
      repo,
      "f3",
      { meta: { title: "stack layer" }, groups: [{ title: "x", items: files.map(([status, path]) => ({ path, status: status.charAt(0) })) }] },
      `--mode pr --base auth --head api --stack ${stackJson}`,
    );
    check(S, "a stack layer doesn't rebuild when its branch moves", /"follow":false/.test(readFileSync(html, "utf8").match(/id="recipe">([^<]*)/)?.[1] ?? ""));
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    const layers = await page.locator(".stack-bar .stack-step").count();
    check(S, "stack bar shows the layers", layers >= 3, `${layers} entries`);
    await page.locator(".row .diff-toggle").first().click();
    await sleep(2500);
    const hint = await page.locator(".editor-bar .hint").first().innerText().catch(() => "");
    check(S, "the checked-out layer is editable", hint.startsWith("editable"), hint);
    check(S, "stack page: no errors", errors.length === 0, errors.join(" | "));
    await page.close();
    server.stop();
  }
};

/* ---- G: the commit bar of a served review - commits, staged, working ----- */
const scenarioG = async () => {
  const S = "G";
  const repo = fresh("repo-g");
  gitInit(repo);
  write(repo, { "a.ts": "const a = 1;\nconst aa = 2;\n", "b.ts": "const b = 1;\nconst bb = 2;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "a.ts", "a = 1", "a = 10");
  swap(repo, "b.ts", "b = 1", "b = 10");
  sh("git commit -qam 'the one commit'", repo);
  const commitShort = sh("git rev-parse --short=7 HEAD", repo).trim();
  const { html } = build(
    repo,
    "g",
    { meta: { title: "G" }, groups: [{ title: "Both", items: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "M" }] }] },
    "--mode pr --base main --head HEAD",
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  const steps = async () =>
    (await page.locator(".commit-bar .commit-step").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  const barShown = await until(async () => (await steps()).length >= 2);
  const first = await steps();
  check(S, "one commit, nothing local: the bar shows all and the commit", barShown !== undefined && first.length === 2 && first[1].startsWith(commitShort), JSON.stringify(first));

  swap(repo, "a.ts", "aa = 2", "aa = 20");
  sh("git add a.ts", repo);
  swap(repo, "a.ts", "a = 10", "a = 100");
  swap(repo, "b.ts", "bb = 2", "bb = 20");
  const local = await until(async () => {
    const now = await steps();
    return now.length === 4 ? now : undefined;
  });
  check(S, "staged and working appear", local !== undefined && local[2] === "staged" && local[3] === "working", JSON.stringify(local ?? (await steps())));

  const openStop = async (label) => {
    await page.locator(".commit-bar .commit-step", { hasText: label }).first().click();
    await sleep(1500);
  };
  const diffOf = async (path, commit) => {
    const toggle = page.locator(`.row[data-path="${path}"] .diff-toggle`);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const key = commit === undefined ? path : `${commit}:${path}`;
    await until(() => model(page, "modified", key));
    return {
      before: await model(page, "original", key),
      after: await model(page, "modified", key),
      refs: (await page.locator(`.row[data-path="${path}"] .diff-refs`).innerText().catch(() => "")).trim(),
      hint: (await page.locator(`.row[data-path="${path}"] .editor-bar .hint`).innerText().catch(() => "")).trim(),
    };
  };

  await openStop("staged");
  check(S, "staged reads only the staged file", JSON.stringify(await rowsOf(page)) === '["a.ts"]', JSON.stringify(await rowsOf(page)));
  const staged = await diffOf("a.ts", "staged");
  check(S, "staged is HEAD → index", staged.before?.includes("aa = 2") && staged.after?.includes("aa = 20") && staged.after?.includes("a = 10;"), `${staged.before?.split("\n")[1]} → ${staged.after?.split("\n")[1]}`);
  check(S, "staged names its sides", /^diff feature \(\w{7}\) → index$/.test(staged.refs), staged.refs);
  check(S, "staged is read-only, and says where to edit", staged.hint.includes("this is what's staged"), staged.hint);

  await openStop("working");
  check(S, "working reads both edited files", JSON.stringify((await rowsOf(page)).sort()) === '["a.ts","b.ts"]', JSON.stringify(await rowsOf(page)));
  const working = await diffOf("a.ts", "working");
  check(S, "working is index → disk", working.before?.includes("a = 10;") && working.after?.includes("a = 100;"), `${working.before?.split("\n")[0]} → ${working.after?.split("\n")[0]}`);
  check(S, "working names its sides", /^diff index → working tree$/.test(working.refs), working.refs);
  check(S, "working is editable", working.hint.startsWith("editable"), working.hint);
  await page.evaluate(() => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => decodeURIComponent(e.getModel()?.uri.toString() ?? "") === "inmemory://review/modified/working:a.ts");
    editor.executeEdits("test", [{ range: new window.monaco.Range(3, 1, 3, 1), text: "// edited under working\n" }]);
  });
  const saved = await until(() => readFileSync(join(repo, "a.ts"), "utf8").includes("edited under working"));
  check(S, "an edit under working saves to disk", saved === true);

  await openStop(commitShort);
  const commit = await diffOf("a.ts", sh("git rev-parse HEAD", repo).trim());
  check(S, "the commit is its parent → itself", commit.before?.includes("a = 1;") && commit.after?.includes("a = 10;"), `${commit.before?.split("\n")[0]} → ${commit.after?.split("\n")[0]}`);
  check(S, "the commit names its sides", /^diff main \(\w{7}\) → feature \(\w{7}\)$/.test(commit.refs), commit.refs);
  check(S, "an edit to the commit is held against it, not saved to disk", commit.hint.includes("edits are held against this commit"), commit.hint);

  await openStop("staged");
  sh("git add b.ts", repo);
  const arrived = await until(async () => (await rowsOf(page)).includes("b.ts"));
  check(S, "git add shows in staged as it happens", arrived === true, JSON.stringify(await rowsOf(page)));

  const url = new URL(page.url());
  check(S, "the stop being read is in the url", url.searchParams.get("commit") === "staged", url.search);
  const again = (await open(server.port)).page;
  await again.goto(url.toString());
  const back = await until(async () => (await again.locator(".commit-bar .commit-step.is-current").innerText().catch(() => "")).includes("staged"));
  check(S, "a reload comes back to the stop", back === true);
  await again.close();

  sh("git add -A && git commit -qm 'second commit'", repo);
  const after = await until(async () => {
    const now = await steps();
    return now.length === 3 && !now.includes("staged") && !now.includes("working") ? now : undefined;
  }, 30_000);
  check(S, "after committing: all and two commits", after !== undefined, JSON.stringify(await steps()));
  const current = (await page.locator(".commit-bar .commit-step.is-current").innerText().catch(() => "")).trim();
  check(S, "staged gone: the page reads all again", current === "all", current);
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- H: rows follow the change - dropped files go, statuses are current -- */
const scenarioH = async () => {
  const S = "H";
  const repo = fresh("repo-h");
  gitInit(repo);
  write(repo, { "m.ts": "const m = 1;\n", "r.ts": "const r = 1;\n", "z.ts": "const z = 1;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "m.ts", "m = 1", "m = 2");
  swap(repo, "r.ts", "r = 1", "r = 2");
  swap(repo, "z.ts", "z = 1", "z = 2");
  write(repo, { "n.ts": "export const n = 'added by the branch';\n" });
  sh("git add . && git commit -qm feature", repo);
  const { html } = build(
    repo,
    "h",
    {
      meta: { title: "H" },
      groups: [
        { title: "First", items: [{ path: "r.ts", status: "M" }, { path: "n.ts", status: "A" }] },
        { title: "Second", items: [{ path: "m.ts", status: "M" }, { path: "z.ts", status: "M" }] },
      ],
    },
    "--mode pr --base main --head HEAD",
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  await untickAll(page);
  check(S, "all four rows to start", JSON.stringify(await rowsOf(page)) === '["r.ts","n.ts","m.ts","z.ts"]', JSON.stringify(await rowsOf(page)));
  await openDiff(page, "z.ts");

  sh("rm m.ts", repo);
  const deleted = await until(async () => (await rowInfo(page, "m.ts"))?.chips.includes("Deleted"));
  check(S, "a modified file since deleted shows D", deleted === true, JSON.stringify((await rowInfo(page, "m.ts"))?.chips));
  const treeLetter = await page.locator('.tree-file-link[title="m.ts"]').locator("xpath=..").locator(".chip-letter").innerText().catch(() => "");
  check(S, "...in the contents too", treeLetter === "D", treeLetter);

  sh("git show main:r.ts > r.ts", repo);
  const reverted = await until(async () => !(await rowsOf(page)).includes("r.ts"));
  check(S, "a reverted file drops out of view", reverted === true, JSON.stringify(await rowsOf(page)));
  check(S, "no marker left behind", (await page.locator(".chip-gone").count()) === 0);
  const zOpen = await page.locator('.row[data-path="z.ts"] .diff-toggle').getAttribute("aria-expanded");
  check(S, "an open diff stays open when a row above it goes", zOpen === "true", zOpen);

  sh("rm n.ts", repo);
  const addedGone = await until(async () => !(await rowsOf(page)).includes("n.ts"));
  check(S, "an added file since deleted drops out", addedGone === true, JSON.stringify(await rowsOf(page)));
  const titles = await page.locator(".group").allInnerTexts();
  check(S, "a chapter left empty goes too", !titles.some((title) => title.includes("First")), JSON.stringify(titles.map((t) => t.split("\n")[0])));

  swap(repo, "r.ts", "r = 1", "r = 3");
  const back = await until(async () => {
    const now = await rowsOf(page);
    return now.indexOf("r.ts") === 0 ? now : undefined;
  });
  check(S, "a file whose change returns comes back in its place", back !== undefined, JSON.stringify(await rowsOf(page)));
  const zStill = await page.locator('.row[data-path="z.ts"] .diff-toggle').getAttribute("aria-expanded");
  check(S, "...and the open diff below it is still open", zStill === "true", zStill);
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};


/* ---- I: mechanical changes - found, marked, and pre-ticked when agreed --- */
const scenarioI = async () => {
  const S = "I";
  const repo = fresh("repo-i");
  gitInit(repo);
  write(repo, {
    "util.ts": "export const oldName = (value: number): number => value * 2;\nexport const foo = (): number => 1;\nexport const bar = (): number => 2;\n",
    "a.ts": "import { oldName } from \"./util\";\nexport const a = oldName(1) + oldName(2);\n",
    "b.ts": "import { oldName } from \"./util\";\nexport const b = (x: number): number => oldName(x);\n",
    "c.ts": "export const c = (x: number): number => x + 1;\n",
    "lib/helper.ts": "export const help = 1;\n",
    "d.ts": "import { help } from \"./lib/helper\";\nexport const d = help;\n",
    "e.ts": "import { foo } from \"./util\";\nexport const e = foo();\n",
    "f.ts": "export const f = call(alpha, beta, gamma);\nconst call = (...args: unknown[]) => args;\nconst alpha = 1, beta = 2, gamma = 3;\n",
    "g.ts": "import { foo } from \"./util\";\nexport const g = foo() + 1;\n",
  });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  for (const file of ["util.ts", "a.ts", "b.ts"]) swap(repo, file, "oldName", "newName", true);
  swap(repo, "c.ts", "x + 1", "x + 2");
  sh("mkdir -p lib2 && git mv lib/helper.ts lib2/helper.ts", repo);
  swap(repo, "d.ts", "./lib/helper", "./lib2/helper");
  swap(repo, "e.ts", "import { foo }", "import { bar }");
  swap(repo, "e.ts", "foo()", "bar()");
  write(repo, { "f.ts": "export const f = call(\n  alpha,\n  beta,\n  gamma,\n);\nconst call = (...args: unknown[]) => args;\nconst alpha = 1, beta = 2, gamma = 3;\n" });
  sh("git add -A && git commit -qm feature", repo);

  const found = JSON.parse(sh(`node ${SKILL}/mechanical.ts pr main HEAD --json`, repo));
  check(S, "a rename everywhere is mechanical", found["a.ts"]?.includes("rename oldName → newName") && found["b.ts"] !== undefined && found["util.ts"] !== undefined, JSON.stringify(found));
  check(S, "an import path change is mechanical", found["d.ts"] === "imports", found["d.ts"]);
  check(S, "reformatting is mechanical", found["f.ts"] === "reformatted", found["f.ts"]);
  check(S, "a real change isn't", found["c.ts"] === undefined, found["c.ts"]);
  check(S, "switching to another existing function isn't a rename", found["e.ts"] === undefined, found["e.ts"]);
  check(S, "an untouched-by-rename file isn't listed", found["g.ts"] === undefined);

  const items = ["util.ts", "a.ts", "b.ts", "c.ts", "lib2/helper.ts", "d.ts", "e.ts", "f.ts"].map((path) => ({
    path,
    status: path === "lib2/helper.ts" ? "R" : "M",
  }));
  const ticked = async (page) =>
    page.locator(".row").evaluateAll((nodes) =>
      nodes.filter((node) => node.querySelector("input.tick").checked).map((node) => node.getAttribute("data-path")).sort(),
    );

  // agreed: pre-ticked
  {
    // reviews new to this run: an earlier run's ticks would be kept, correctly
    const { html } = build(repo, "i-yes", { meta: { title: "I", preTickMechanical: true }, groups: [{ title: "All", items }] }, `--mode pr --base main --head HEAD --id i-agreed-${Date.now()}`);
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    const expected = Object.keys(found).sort();
    const now = await ticked(page);
    check(S, "agreed: the mechanical files start ticked", JSON.stringify(now) === JSON.stringify(expected), `${JSON.stringify(now)} vs ${JSON.stringify(expected)}`);
    const chip = await page.locator('.row[data-path="a.ts"] .chip-mechanical').getAttribute("title").catch(() => null);
    check(S, "a mechanical row says why", chip?.includes("rename oldName → newName"), chip);
    await page.locator('.row[data-path="a.ts"] input.tick').uncheck();
    await sleep(1500);
    await page.reload();
    await page.waitForSelector(".row");
    await sleep(1500);
    const afterReload = await ticked(page);
    check(S, "the reader's own untick sticks across a reload", !afterReload.includes("a.ts") && afterReload.includes("b.ts"), JSON.stringify(afterReload));
    check(S, "no page errors", errors.length === 0, errors.join(" | "));
    await page.close();
    server.stop();
  }
  // not agreed: marked, not ticked
  {
    // a review of its own: the same branch would otherwise share the first's ticks
    const { html } = build(repo, "i-no", { meta: { title: "I" }, groups: [{ title: "All", items }] }, `--mode pr --base main --head HEAD --id i-not-agreed-${Date.now()}`);
    const server = await serve(repo, html);
    const { page } = await open(server.port);
    check(S, "not agreed: nothing starts ticked", (await ticked(page)).length === 0, JSON.stringify(await ticked(page)));
    check(S, "...but the mechanical rows are still marked", (await page.locator(".chip-mechanical").count()) === Object.keys(found).length);
    await page.close();
    server.stop();
  }
};


/* ---- J: ticks on files with uncommitted edits ---------------------------- */
const scenarioJ = async () => {
  const S = "J";
  const repo = fresh("repo-j");
  gitInit(repo);
  write(repo, { "a.ts": "const a = 1;\n", "b.ts": "const b = 1;\n", "c.ts": "const c = 1;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "a.ts", "a = 1", "a = 2");
  swap(repo, "b.ts", "b = 1", "b = 2");
  swap(repo, "c.ts", "c = 1", "c = 2");
  sh("git commit -qam feature", repo);
  const id = `j-${Date.now()}`;
  const { html } = build(
    repo,
    "j",
    { meta: { title: "J" }, groups: [{ title: "All", items: ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, status: "M" })) }] },
    `--mode pr --base main --head HEAD --id ${id}`,
  );
  // uncommitted work on top of the branch, before the page is ever opened
  sh("printf 'const aa = 3;\\n' >> a.ts && printf 'const bb = 3;\\n' >> b.ts", repo);
  const ticksFile = join(ROOT, id, "ticks.json");
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  const isTicked = (path) => page.locator(`.row[data-path="${path}"] input.tick`).isChecked();

  // 1. tick a file with uncommitted edits, reload: still ticked
  await page.locator('.row[data-path="a.ts"] input.tick').check();
  // b.ts too: before the fix a reload marked it changed, and the mark stuck
  await page.locator('.row[data-path="b.ts"] input.tick').check();
  await sleep(1500);
  const stored = JSON.parse(readFileSync(ticksFile, "utf8"));
  check(S, "a tick is stored with what it was of", stored.some((entry) => entry.key === "a.ts" && typeof entry.sha === "string"), JSON.stringify(stored));
  await page.reload();
  await page.waitForSelector(".row");
  await sleep(5000);
  check(S, "reloading keeps the tick on a file with uncommitted edits", (await isTicked("a.ts")) && (await isTicked("b.ts")));
  check(S, "...and doesn't mark it changed", (await rowInfo(page, "a.ts"))?.chips.includes("Changed since read") === false, JSON.stringify((await rowInfo(page, "a.ts"))?.chips));

  // an old ticks.json - plain keys - still works, and keeps its ticks too
  writeFileSync(ticksFile, JSON.stringify(["a.ts", "b.ts"]));
  await page.reload();
  await page.waitForSelector(".row");
  await sleep(5000);
  check(S, "an old plain ticks.json is read, and its ticks kept", (await isTicked("a.ts")) && (await isTicked("b.ts")));

  // 2. a tick written from outside, on a file with uncommitted edits, then an
  // unrelated disk change
  writeFileSync(ticksFile, JSON.stringify(["a.ts", "b.ts", "c.ts"]));
  const taken = await until(async () => (await isTicked("b.ts")) && (await isTicked("c.ts")));
  check(S, "a tick written to ticks.json from outside is taken up", taken === true);
  // another read file really changes: it unticks - and nothing else may
  sh("printf 'const cc = 3;\\n' >> c.ts", repo);
  const cGone = await until(async () => !(await isTicked("c.ts")));
  await sleep(3000);
  check(S, "a read file that really changed unticks", cGone === true);
  check(S, "...while an outside tick survives that unrelated change", await isTicked("b.ts"));
  check(S, "...as does the page's own tick", await isTicked("a.ts"));

  // 3. editing a ticked file after the tick still unticks it
  sh("printf 'const aaa = 4;\\n' >> a.ts", repo);
  const unticked = await until(async () => !(await isTicked("a.ts")));
  check(S, "editing a ticked file afterwards unticks it", unticked === true);
  check(S, "...marked changed since read", (await rowInfo(page, "a.ts"))?.chips.includes("Changed since read"), JSON.stringify((await rowInfo(page, "a.ts"))?.chips));
  check(S, "...while the other tick stays", await isTicked("b.ts"));
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};


/* ---- K: Space ticks the file being read --------------------------------- */
const scenarioK = async () => {
  const S = "K";
  const repo = fresh("repo-k");
  gitInit(repo);
  write(repo, { "a.ts": "const a = 1;\n", "b.ts": "const b = 1;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "a.ts", "a = 1", "a = 2");
  swap(repo, "b.ts", "b = 1", "b = 2");
  sh("git commit -qam feature", repo);
  const { html } = build(
    repo,
    "k",
    { meta: { title: "K" }, groups: [{ title: "All", items: ["a.ts", "b.ts"].map((path) => ({ path, status: "M" })) }] },
    `--mode pr --base main --head HEAD --id k-${Date.now()}`,
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  const isTicked = (path) => page.locator(`.row[data-path="${path}"] input.tick`).isChecked();

  // go to b.ts from the contents: it becomes the file being read
  await page.locator('.tree-file-link[title="b.ts"]').click();
  await sleep(1200);
  await page.locator("h1, .intro, body").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("Space");
  await sleep(500);
  check(S, "Space ticks the file being read", (await isTicked("b.ts")) && !(await isTicked("a.ts")));
  await page.locator('.tree-file-link[title="b.ts"]').click();
  await sleep(800);
  await page.keyboard.press("Space");
  await sleep(500);
  check(S, "Space again unticks it", !(await isTicked("b.ts")));

  // with a button focused, Space ticks rather than pressing it
  await page.locator('.tree-file-link[title="a.ts"]').click();
  await sleep(800);
  await openDiff(page, "a.ts");
  const toggle = page.locator('.row[data-path="a.ts"] .diff-toggle');
  await toggle.focus();
  await page.keyboard.press("Space");
  await sleep(500);
  check(S, "over a focused button, Space ticks", await isTicked("a.ts"));
  check(S, "...and doesn't press the button", (await toggle.getAttribute("aria-expanded")) === "true");
  await page.locator('.row[data-path="a.ts"] input.tick').uncheck();
  await sleep(500);
  await openDiff(page, "a.ts");

  // typing in monaco: Space is a space
  await page.locator('.row[data-path="a.ts"] .diff-monaco .modified .view-lines, .row[data-path="a.ts"] .diff-monaco .view-lines').last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await sleep(500);
  const typed = await model(page, "modified", "a.ts");
  check(S, "in an editor, Space types a space", typed !== "const a = 2;\n" && typed?.replace(/\s/g, "") === "consta=2;", JSON.stringify(typed));
  check(S, "...and doesn't tick", !(await isTicked("a.ts")));
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- L: a file edited elsewhere says where, and links there ------------- */
const scenarioL = async () => {
  const S = "L";
  const alsoOf = (page, path) =>
    page.locator(`.row[data-path="${path}"]`).evaluateAll((rows) =>
      rows.map((row) => row.querySelector(".also-edited")?.textContent.replace(/\s+/g, " ").trim() ?? ""),
    );
  const where = (page) => {
    const url = new URL(page.url());
    return { review: url.searchParams.get("review"), commit: url.searchParams.get("commit") ?? undefined };
  };
  /** whether the page has landed on the file: its row open and on screen */
  const landedOn = (page, path) =>
    page.evaluate((path) => {
      const row = document.querySelector(`.row[data-path="${path}"]`);
      const box = row?.getBoundingClientRect();
      return row !== null && box !== undefined && box.top < window.innerHeight && box.bottom > 0 && !row.querySelector(".row-body").hidden;
    }, path);
  const follow = async (page, path, text) => {
    await page.locator(`.row[data-path="${path}"] a.also-place`, { hasText: text }).first().click();
    await sleep(1200);
  };

  // a stack of two PRs, read commit by commit: a.ts twice in one, b.ts in each
  {
    const repo = fresh("repo-l");
    gitInit(repo);
    write(repo, { "README.md": "l\n" });
    sh("git add . && git commit -qm trunk && git checkout -qb one", repo);
    const commit = (files, message) => {
      write(repo, files);
      sh(`git add . && git commit -qm '${message}'`, repo);
      return sh("git rev-parse HEAD", repo).trim();
    };
    const one1 = commit({ "a.ts": "const a = 1;\n" }, "one: add a");
    const one2 = commit({ "b.ts": "const b = 1;\n" }, "one: add b");
    const one3 = commit({ "a.ts": "const a = 2;\n" }, "one: change a");
    sh("git checkout -qb two", repo);
    const two1 = commit({ "b.ts": "const b = 2;\n", "c.ts": "const c = 1;\n" }, "two: change b, add c");
    const two2 = commit({ "c.ts": "const c = 2;\n" }, "two: change c");
    // a PR nobody has reviewed still counts as one of the stack's
    sh("git checkout -qb three", repo);
    commit({ "b.ts": "const b = 3;\n" }, "three: change b");
    const dir = fresh("stack-l");
    const entry = (key, base) => ({ key, label: key, title: key, url: "", base, head: key });
    writeFileSync(join(dir, "stack.json"), JSON.stringify({ current: "two", entries: [entry("one", "main"), entry("two", "one"), entry("three", "two")] }));
    const item = (path, status) => ({ path, status, note: `${path} here` });
    const perCommit = (commits) => ({
      meta: { title: "L" },
      commits: commits.map(([ref, items]) => ({ ref, groups: [{ title: ref.slice(0, 7), items }] })),
    });
    writeFileSync(
      join(dir, "one.groups.json"),
      JSON.stringify(perCommit([[one1, [item("a.ts", "A")]], [one2, [item("b.ts", "A")]], [one3, [item("a.ts", "M")]]])),
    );
    writeFileSync(
      join(dir, "two.groups.json"),
      JSON.stringify(perCommit([[two1, [item("b.ts", "M"), item("c.ts", "A")]], [two2, [item("c.ts", "M")]]])),
    );
    const html = join(ROOT, "l.html");
    sh(`node ${SKILL}/buildStack.ts --dir ${dir} --out ${html} --repo .`, repo);
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    await page.goto(`http://127.0.0.1:${server.port}/?review=one`);
    await page.waitForSelector(".row");
    await sleep(800);

    check(S, "a file edited in another PR says which PR and commit", JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 2/3 commit 1/2; PR 3/3"]', JSON.stringify(await alsoOf(page, "b.ts")));
    check(S, "a file whose every edit is on the page says nothing", JSON.stringify(await alsoOf(page, "a.ts")) === '["",""]', JSON.stringify(await alsoOf(page, "a.ts")));

    check(S, "a PR the page has no review of is named, not linked", (await page.locator('.row[data-path="b.ts"] span.also-place', { hasText: "PR 3/3" }).count()) === 1);
    await follow(page, "b.ts", "PR 2/3");
    check(S, "the PR link reads that whole PR", JSON.stringify(where(page)) === '{"review":"two"}', JSON.stringify(where(page)));
    check(S, "...landed on the same file", await landedOn(page, "b.ts"));
    check(S, "...which says where else it is edited, from there", JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 1/3 commit 2/3; PR 3/3"]', JSON.stringify(await alsoOf(page, "b.ts")));

    await follow(page, "b.ts", "2/3");
    check(S, "a commit link reads that commit of that PR", where(page).review === "one" && where(page).commit === one2, JSON.stringify(where(page)));
    check(S, "...landed on the same file", await landedOn(page, "b.ts"));

    await page.locator(".commit-bar .commit-step").nth(1).click();
    await sleep(1000);
    check(S, "reading one commit, the file's other commits in the same PR are named", JSON.stringify(await alsoOf(page, "a.ts")) === '["also edited in PR 1/3 commit 3/3"]', JSON.stringify(await alsoOf(page, "a.ts")));
    await follow(page, "a.ts", "3/3");
    check(S, "a link to another commit of the same PR reads it", where(page).review === "one" && where(page).commit === one3, JSON.stringify(where(page)));

    await page.locator(".stack-bar .stack-all").click();
    await sleep(1200);
    // the commit being read comes along when the review it's in is there too
    if (where(page).commit !== undefined) {
      await page.locator(".commit-bar .commit-step").first().click();
      await sleep(1000);
    }
    const everywhere = await page.locator(".also-edited").count();
    check(S, "reading every reviewed PR and every commit, only the unreviewed PR is named", where(page).review === "all" && everywhere === 2 && JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 3/3","also edited in PR 3/3"]', `${where(page).review}, ${everywhere} lines, ${JSON.stringify(await alsoOf(page, "b.ts"))}`);
    const bands = await page.locator(".band-pr").allInnerTexts();
    check(S, "the every-PR review numbers PRs out of the whole stack, reviewed or not", JSON.stringify(bands) === '["PR 1/3 (one)","PR 2/3 (two)"]', JSON.stringify(bands));
    await page.locator(".commit-bar .commit-step", { hasText: two1.slice(0, 7) }).first().click();
    await sleep(1000);
    check(S, "reading one commit of every PR, the others are named", JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 1/3 commit 2/3; PR 3/3"]', JSON.stringify(await alsoOf(page, "b.ts")));
    await follow(page, "b.ts", "2/3");
    check(S, "...and linked within the every-PR review", where(page).review === "all" && where(page).commit === one2, JSON.stringify(where(page)));
    check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.close();
    server.stop();

    // one layer built on its own still knows where the rest of the stack edits
    sh("git checkout -q two", repo);
    const layer = build(
      repo,
      "l-layer",
      { meta: { title: "two" }, groups: [{ title: "x", items: [item("b.ts", "M"), item("c.ts", "A")] }] },
      `--mode pr --base one --head two --stack ${join(dir, "stack.json")} --id l-layer-${Date.now()}`,
    );
    const layerServer = await serve(repo, layer.html);
    const opened = await open(layerServer.port);
    check(S, "a layer built alone names the stack's other PRs and commits", JSON.stringify(await alsoOf(opened.page, "b.ts")) === '["also edited in PR 1/3 commit 2/3; PR 3/3"]', JSON.stringify(await alsoOf(opened.page, "b.ts")));
    check(S, "...as text, since the page has no review of them", (await opened.page.locator('.row[data-path="b.ts"] a.also-place').count()) === 0);
    check(S, "no page errors (a layer alone)", opened.errors.length === 0, opened.errors.slice(0, 3).join(" | "));
    await opened.page.close();
    layerServer.stop();
  }

  // one PR, not authored per commit: its commits are the served commit bar's
  {
    const repo = fresh("repo-l2");
    gitInit(repo);
    write(repo, { "x.ts": "const x = 0;\n" });
    sh("git add . && git commit -qm base && git checkout -qb solo", repo);
    write(repo, { "x.ts": "const x = 1;\n", "y.ts": "const y = 1;\n" });
    sh("git add . && git commit -qm 'x and y'", repo);
    write(repo, { "x.ts": "const x = 2;\n" });
    sh("git commit -qam 'x again'", repo);
    const head = sh("git rev-parse HEAD", repo).trim();
    const { html } = build(
      repo,
      "l2",
      { meta: { title: "L2" }, groups: [{ title: "Both", items: [{ path: "x.ts", status: "M" }, { path: "y.ts", status: "A" }] }] },
      `--mode pr --base main --head HEAD --id l2-${Date.now()}`,
    );
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    await until(async () => (await page.locator(".commit-bar .commit-step").count()) >= 3);
    check(S, "reading the whole of a lone PR, nothing is elsewhere", (await page.locator(".also-edited").count()) === 0);
    await page.locator(".commit-bar .commit-step").nth(1).click();
    await sleep(1500);
    check(S, "a lone PR's commit names the file's other commits, without a PR", JSON.stringify(await alsoOf(page, "x.ts")) === '["also edited in commit 2/2"]', JSON.stringify(await alsoOf(page, "x.ts")));
    check(S, "...and a file only that commit edits says nothing", JSON.stringify(await alsoOf(page, "y.ts")) === '[""]', JSON.stringify(await alsoOf(page, "y.ts")));
    await follow(page, "x.ts", "2/2");
    check(S, "a link to a commit of the served bar reads it", where(page).commit === head, JSON.stringify(where(page)));
    check(S, "...landed on the same file", await landedOn(page, "x.ts"));
    check(S, "no page errors (lone PR)", errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.close();
    server.stop();
  }
};

/* ---- M: the fs tree is a tree widget - keyboard, ranges, ticking a selection */
const scenarioM = async () => {
  const S = "M";
  const repo = fresh("repo-m");
  gitInit(repo);
  write(repo, { "README.md": "m\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  const paths = ["lib/a.ts", "lib/b.ts", "lib/c.ts", "web/d.ts", "web/e.ts"];
  write(repo, Object.fromEntries(paths.map((path) => [path, `export const x = "${path}";\n`])));
  sh("git add . && git commit -qm files", repo);
  const { html } = build(
    repo,
    "m",
    { meta: { title: "M" }, groups: [{ title: "All", items: paths.map((path) => ({ path, status: "A" })) }] },
    `--mode pr --base main --head HEAD --id m-${Date.now()}`,
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  await page.selectOption('select[aria-label="Contents view"]', "tree");
  await page.waitForSelector(".fs-tree [role=treeitem]");
  const item = (name) => page.locator(`.tree[role="tree"] [role=treeitem][aria-label="${name}"]`);
  const ticked = async () =>
    (await page.locator(".row").evaluateAll((rows) => rows.filter((row) => row.querySelector("input.tick").checked).map((row) => row.dataset.path))).sort();
  const selected = () => page.locator('.tree[role="tree"] [role=treeitem][aria-selected="true"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
  const press = async (key) => {
    await page.keyboard.press(key);
    await sleep(300);
  };

  check(S, "a directory shows its fold caret", (await page.locator(".fs-dir-caret").first().textContent())?.trim() !== "");
  check(S, "the fs tree is a tree, one tab stop", (await page.locator('.fs-tree[role="tree"]').count()) === 1 && (await page.locator('.fs-tree [role=treeitem][tabindex="0"]').count()) === 1);
  await item("lib/a.ts").click();
  await item("lib/c.ts").click({ modifiers: ["Shift"] });
  check(S, "shift-click selects the range", JSON.stringify(await selected()) === '["lib/a.ts","lib/b.ts","lib/c.ts"]', JSON.stringify(await selected()));
  await press("Space");
  check(S, "Space ticks everything selected", JSON.stringify(await ticked()) === '["lib/a.ts","lib/b.ts","lib/c.ts"]', JSON.stringify(await ticked()));
  check(S, "...and the tree keeps the focus", (await focused()) !== null && (await focused()).startsWith("lib/"), String(await focused()));
  await press("Space");
  check(S, "Space again, all of it ticked, unticks it", (await ticked()).length === 0, JSON.stringify(await ticked()));

  await item("lib/c.ts").click();
  await item("web/d.ts").click({ modifiers: ["Shift"] });
  await press("Space");
  check(S, "a range through a directory's heading ticks only the range", JSON.stringify(await ticked()) === '["lib/c.ts","web/d.ts"]', JSON.stringify(await ticked()));
  await press("Space");

  await item("lib/a.ts").click();
  await item("web/d.ts").click({ modifiers: ["ControlOrMeta"] });
  check(S, "ctrl/cmd-click adds to the selection", JSON.stringify(await selected()) === '["lib/a.ts","web/d.ts"]', JSON.stringify(await selected()));
  await item("web/d.ts").locator("input.tick").check();
  await sleep(300);
  check(S, "ticking a selected file's box ticks the whole selection", JSON.stringify(await ticked()) === '["lib/a.ts","web/d.ts"]', JSON.stringify(await ticked()));
  await item("lib/b.ts").locator("input.tick").check();
  await sleep(300);
  check(S, "...but an unselected file's box ticks just that file", JSON.stringify(await ticked()) === '["lib/a.ts","lib/b.ts","web/d.ts"]', JSON.stringify(await ticked()));
  await page.getByRole("button", { name: "Clear ticks" }).click();
  await sleep(300);

  await item("lib").click();
  check(S, "clicking a directory folds it", (await item("lib").getAttribute("aria-expanded")) === "false");
  await press("ArrowRight");
  await press("ArrowDown");
  check(S, "arrows move through the tree", (await focused()) === "lib/a.ts", String(await focused()));
  await press("Enter");
  check(S, "Enter goes to the file", new URL(page.url()).searchParams.get("file") === "lib/a.ts", page.url());
  await press("Home");
  await press("ArrowLeft");
  check(S, "left folds a directory", (await item("lib").getAttribute("aria-expanded")) === "false");
  await press("ArrowRight");
  check(S, "right unfolds it", (await item("lib").getAttribute("aria-expanded")) === "true");
  await press("Space");
  check(S, "Space on a directory ticks every file in it", JSON.stringify(await ticked()) === '["lib/a.ts","lib/b.ts","lib/c.ts"]', JSON.stringify(await ticked()));
  check(S, "...without Space on the page ticking the file being read as well", !(await ticked()).includes("web/d.ts"));
  await page.getByRole("button", { name: "Clear ticks" }).click();
  await sleep(300);

  // the chapters view is the same tree widget
  await page.selectOption('select[aria-label="Contents view"]', "guided");
  await page.waitForSelector('.tree[role="tree"] [role=treeitem]');
  check(S, "a chapter shows its fold caret", (await page.locator(".tree-group-head .caret").first().textContent())?.trim() !== "");
  check(S, "the chapters view is a tree too, one tab stop", (await page.locator('.tree[role="tree"]').count()) === 1 && (await page.locator('.tree [role=treeitem][tabindex="0"]').count()) === 1);
  await item("lib/a.ts").click();
  await item("web/d.ts").click({ modifiers: ["Shift"] });
  await press("Space");
  check(S, "in chapters, a shift-range through a directory heading ticks just the range", JSON.stringify(await ticked()) === '["lib/a.ts","lib/b.ts","lib/c.ts","web/d.ts"]', JSON.stringify(await ticked()));
  await press("Space");
  check(S, "...and Space again unticks it", (await ticked()).length === 0, JSON.stringify(await ticked()));
  await item("lib/c.ts").click();
  await item("All").click();
  await sleep(500);
  check(S, "clicking a chapter goes to its first file", new URL(page.url()).searchParams.get("file") === "lib/a.ts", page.url());
  check(S, "...without folding it", (await item("All").getAttribute("aria-expanded")) === "true");
  await press("ArrowLeft");
  check(S, "left folds a chapter", (await item("All").getAttribute("aria-expanded")) === "false");
  await press("ArrowRight");
  await press("Space");
  check(S, "Space on a chapter ticks every file in it", (await ticked()).length === 5, JSON.stringify(await ticked()));
  await press("Space");
  check(S, "...and again unticks them", (await ticked()).length === 0, JSON.stringify(await ticked()));

  // sidebar entries are real links, so they open in a tab of their own
  const link = page.locator('.tree [role=treeitem][aria-label="web/e.ts"] a.tree-file-link');
  const href = await link.getAttribute("href");
  check(S, "a sidebar file is a link to it", href !== null && new URL(href).searchParams.get("file") === "web/e.ts", String(href));
  const [tab] = await Promise.all([page.context().waitForEvent("page", { timeout: 10_000 }), link.click({ button: "middle" })]);
  await tab.waitForSelector(".row", { state: "attached" });
  await sleep(1500);
  check(S, "...which a middle-click opens in a new tab, on that file", new URL(tab.url()).searchParams.get("file") === "web/e.ts", tab.url());
  await tab.close();
  check(S, "...while a plain click stays in the page", (await page.context().pages()).length === 1);
  check(S, "a chapter heading links to its first file", new URL((await page.locator(".tree-group-title").first().getAttribute("href")) ?? "http://x").searchParams.get("file") === "lib/a.ts");

  // and the diff-size view
  await page.selectOption('select[aria-label="Contents view"]', "size");
  await page.waitForSelector('.tree-flat[role="tree"] [role=treeitem]');
  const flat = await page.locator('.tree-flat [role=treeitem]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  await item(flat[0]).click();
  await item(flat[2]).click({ modifiers: ["Shift"] });
  await press("Space");
  check(S, "in diff size, shift-click and Space tick the range", JSON.stringify(await ticked()) === JSON.stringify(flat.slice(0, 3).sort()), `${JSON.stringify(await ticked())} of ${JSON.stringify(flat)}`);
  await page.keyboard.press("ArrowDown");
  check(S, "...and the arrows move down the list", (await focused()) !== null);
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- N: switching the checkout to another PR of the stack ------------------ */
const scenarioN = async () => {
  const S = "N";
  const repo = join(ROOT, "repo-n");
  rmSync(repo, { recursive: true, force: true });
  sh(`${SKILL}/fixtures/localStack.sh ${repo}`, ROOT);
  sh("git checkout -q api", repo);
  const stackJson = join(ROOT, "n-stack.json");
  writeFileSync(stackJson, sh(`node ${SKILL}/resolveStack.ts --stack`, repo));
  const files = sh(`${SKILL}/changedFiles.sh pr auth api`, repo)
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  const { html } = build(
    repo,
    "n",
    { meta: { title: "api" }, groups: [{ title: "x", items: files.map(([status, path]) => ({ path, status: status.charAt(0) })) }] },
    `--mode pr --base auth --head api --stack ${stackJson} --id n-${Date.now()}`,
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  const branch = () => sh("git rev-parse --abbrev-ref HEAD", repo).trim();
  const step = (name) => page.locator(".stack-step", { has: page.locator(".stack-number", { hasText: new RegExp(`^${name}$`) }) });

  check(S, "the checked-out PR says so", (await step("api").locator(".stack-checked-out").count()) === 1);
  check(S, "every other PR offers to switch to it", (await step("auth").locator(".stack-switch").count()) === 1 && (await step("ui").locator(".stack-switch").count()) === 1);

  await step("ui").locator(".stack-switch").click();
  const switched = await until(() => branch() === "ui");
  check(S, "switch to checks the PR's branch out", switched !== undefined, branch());
  await page.waitForSelector(".stack-checked-out");
  await sleep(500);
  check(S, "...and the page says it is checked out now", (await step("ui").locator(".stack-checked-out").count()) === 1 && (await step("api").locator(".stack-switch").count()) === 1);

  // gh stack refusing - a change in the way - says why, and moves nothing
  writeFileSync(join(repo, "src/api/routes.ts"), "// in the way\n");
  await step("auth").locator(".stack-switch").click();
  const said = await until(async () => (await toasts(page)).find((text) => text.includes("couldn't switch to auth")));
  check(S, "a switch git refuses says so", said !== undefined, JSON.stringify(await toasts(page)));
  check(S, "...and leaves the checkout where it was", branch() === "ui", branch());
  sh("git checkout -q -- .", repo);
  // the refused switch's 409 is the browser logging the answer it was given
  const unexpected = errors.filter((error) => !error.includes("status of 409"));
  check(S, "no page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- O: editing any PR - held edits, commit or amend, rebase upstack ------- */
const scenarioO = async () => {
  const S = "O";
  const repo = fresh("repo-o");
  gitInit(repo);
  const git = (cmd) => sh(`git ${cmd}`, repo).trim();
  const commit = (files, message) => {
    write(repo, files);
    sh(`git add -A && git commit -qm '${message}'`, repo);
    return git("rev-parse HEAD");
  };
  const lines = (prefix, count, extra = {}) =>
    Array.from({ length: count }, (_, index) => extra[index + 1] ?? `${prefix}${index + 1}`).join("\n") + "\n";
  commit({ "README.md": "o\n" }, "trunk");
  sh("git checkout -qb one", repo);
  const one1 = commit({ "a.ts": lines("a", 9) }, "one: add a");
  const one2 = commit({ "b.ts": lines("b", 9) }, "one: add b");
  const one3 = commit({ "b.ts": lines("b", 9, { 9: "b9 changed" }) }, "one: change the end of b");
  sh("git checkout -qb two", repo);
  commit({ "c.ts": lines("c", 9) }, "two: add c");
  commit({ "b.ts": lines("b", 9, { 5: "b5 by two", 9: "b9 changed" }) }, "two: change the middle of b");
  sh("git checkout -qb three", repo);
  commit({ "d.ts": lines("d", 9) }, "three: add d");
  sh("git checkout -q main", repo);

  const dir = fresh("stack-o");
  const entry = (key, base) => ({ key, label: key, title: key, url: "", base, head: key });
  writeFileSync(join(dir, "stack.json"), JSON.stringify({ current: "one", entries: [entry("one", "main"), entry("two", "one"), entry("three", "two")] }));
  const item = (path, status) => ({ path, status, note: `${path} here` });
  writeFileSync(
    join(dir, "one.groups.json"),
    JSON.stringify({
      meta: { title: "one" },
      commits: [
        { ref: one1, groups: [{ title: "a", items: [item("a.ts", "A")] }] },
        { ref: one2, groups: [{ title: "b", items: [item("b.ts", "A")] }] },
        { ref: one3, groups: [{ title: "b end", items: [item("b.ts", "M")] }] },
      ],
    }),
  );
  writeFileSync(join(dir, "two.groups.json"), JSON.stringify({ meta: { title: "two" }, groups: [{ title: "two", items: [item("c.ts", "A"), item("b.ts", "M")] }] }));
  writeFileSync(join(dir, "three.groups.json"), JSON.stringify({ meta: { title: "three" }, groups: [{ title: "three", items: [item("d.ts", "A")] }] }));
  const html = join(ROOT, "o.html");
  sh(`node ${SKILL}/buildStack.ts --dir ${dir} --out ${html} --repo .`, repo);
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  page.on("dialog", (dialog) => void dialog.accept());
  const base = `http://127.0.0.1:${server.port}/`;
  const go = async (review, commitSha) => {
    await page.goto(`${base}?review=${review}${commitSha === undefined ? "" : `&commit=${commitSha}`}`);
    await page.waitForSelector(".row", { state: "attached" });
    await sleep(1500);
  };
  const held = (branch) => sh(`git for-each-ref --format='%(objectname)' refs/guided-review/hold/${branch}`, repo).trim();
  const bar = async () => (await page.locator(".commit-bar .commit-step").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  /** types into a row's editor - at its start, its end, or the end of a line -
      placing the cursor through monaco, the same on every platform */
  const edit = async (key, text, { at = "end" } = {}) => {
    const path = key.slice(key.lastIndexOf(":") + 1);
    const row = page.locator(`.row[data-path="${path}"]`).first();
    const toggle = row.locator(".diff-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await until(() => model(page, "modified", key));
    await page.evaluate(
      ([key, at]) => {
        const editor = window.monaco.editor
          .getEditors()
          .find((candidate) => decodeURIComponent(candidate.getModel()?.uri.toString() ?? "") === `inmemory://review/modified/${key}`);
        const content = editor.getModel();
        const line = at === "start" ? 1 : at === "end" ? content.getLineCount() : at;
        editor.setPosition({ lineNumber: line, column: at === "start" ? 1 : content.getLineMaxColumn(line) });
        editor.focus();
      },
      [key, at],
    );
    await page.keyboard.type(text);
    await sleep(1800);
  };
  /** a button that reloads the page once the server has moved the branches
      and rebuilt it */
  const press = async (locator) => {
    // a load, not any navigation: the page's own replaceState of ?file= counts
    // as one, and would let the wait end before the reload has happened
    try {
      await Promise.all([page.waitForEvent("load", { timeout: 60_000 }), locator.click()]);
    } catch (error) {
      throw new Error(`no reload: ${JSON.stringify(await toasts(page))} | server: ${server.log().split("\n").slice(-8).join(" / ")}`, { cause: error });
    }
    await page.waitForSelector(".row", { state: "attached" });
    await sleep(1500);
  };
  const lastToast = async () => (await toasts(page)).at(-1) ?? "";

  // ---- held: a commit's edit is held, not committed
  await go("one", one2);
  await edit(`${one2}:b.ts`, "// held in b\n", { at: "start" });
  const heldOne = await until(() => held("one"));
  check(S, "editing a commit holds the edit", heldOne !== undefined && git(`rev-parse ${heldOne}^`) === one2);
  check(S, "...without moving the branch", git("rev-parse one") === one3);
  await until(async () => (await bar()).includes("held"));
  const order = await bar();
  check(S, "the held edits sit on the commit bar right after that commit", order.indexOf("held") === order.findIndex((text) => text.startsWith(one2.slice(0, 7))) + 1, JSON.stringify(order));
  check(S, "the stack bar marks the PR as holding edits", (await page.locator(".stack-step", { hasText: "one" }).locator(".stack-held").count()) === 1);
  const heldBar = (await page.locator(".held-bar").innerText().catch(() => "")).replace(/\s+/g, " ");
  check(S, "the held bar says what is held, and after which commit", heldBar.includes("1 file edited") && heldBar.includes(one2.slice(0, 7)), heldBar);

  await page.locator(".commit-bar .commit-step", { hasText: "held" }).click();
  await sleep(1500);
  await openDiff(page, "b.ts");
  const heldRow = await model(page, "modified", `held:one:b.ts`);
  check(S, "the held edits have a row of their own", heldRow?.startsWith("// held in b") === true, JSON.stringify(heldRow?.slice(0, 20)));

  await go("one", one2);
  await openDiff(page, "b.ts");
  const afterReload = await until(async () => (await model(page, "modified", `${one2}:b.ts`))?.startsWith("// held in b"));
  check(S, "after a reload, the commit's row shows what is held", afterReload === true);

  await go("one", one3);
  await edit(`${one3}:b.ts`, "// elsewhere\n", { at: "start" });
  const refusal = await until(async () => ((await lastToast()).includes("already held") ? await lastToast() : undefined));
  check(S, "editing another commit of the PR is refused, saying why", refusal !== undefined, JSON.stringify(await toasts(page)));
  check(S, "...and what is held is untouched", held("one") === heldOne);
  await page.locator('.row[data-path="b.ts"] button.save.revert').first().click();

  // ---- amend: into the commit, the later commit replayed, the branch moved
  await go("one", one3);
  await page.locator('.row[data-path="b.ts"] input.tick').first().check();
  await sleep(500);
  await press(page.locator(".held-action", { hasText: "Amend into" }));
  const oneNow = git("rev-parse one");
  check(S, "amending moves the branch", oneNow !== one3);
  check(S, "...folding the edit into that commit, which keeps its message", git("show one~1:b.ts").startsWith("// held in b") && git("log -1 --format=%s one~1") === "one: add b");
  check(S, "...with the later commit replayed on top", git("log -1 --format=%s one") === "one: change the end of b" && git("show one:b.ts").startsWith("// held in b") && git("show one:b.ts").includes("b9 changed"));
  check(S, "...and nothing held any more", held("one") === "");
  check(S, "the branch's old head is backed up", sh("git for-each-ref --format='%(objectname)' refs/guided-review/backup/one", repo).includes(one3));
  const groupsNow = readFileSync(join(dir, "one.groups.json"), "utf8");
  check(S, "the authored commits are renamed to what they became", !groupsNow.includes(one2) && groupsNow.includes(git("rev-parse one~1")));
  check(S, "commits are never named after the page's own backup refs", !readFileSync(html, "utf8").includes('"name":"guided-review/'));
  await go("one", git("rev-parse one"));
  check(S, "a tick follows its commit through the amend", await page.locator('.row[data-path="b.ts"] input.tick').first().isChecked());
  const restackLabel = await page.locator(".stack-restack").innerText().catch(() => "");
  check(S, "the PRs above are offered a rebase upstack", restackLabel === "Rebase 2 upstack", restackLabel);

  // ---- restack: every PR above, replayed
  await press(page.locator(".stack-restack"));
  const onTop = (lower, upper) => sh(`git merge-base --is-ancestor ${lower} ${upper} && echo yes || echo no`, repo).trim() === "yes";
  check(S, "rebasing upstack puts each PR back on the one below", onTop("one", "two") && onTop("two", "three"));
  check(S, "...carrying the edit and the PR's own change", git("show two:b.ts").startsWith("// held in b") && git("show two:b.ts").includes("b5 by two"));
  check(S, "...and nothing is left to restack", (await page.locator(".stack-restack").count()) === 0);

  // ---- a whole-PR edit, as a new commit
  const twoTip = git("rev-parse two");
  await go("two");
  await edit("c.ts", "// more c\n");
  const heldTwo = await until(() => held("two"));
  check(S, "a whole-PR edit is held after the PR's last commit", heldTwo !== undefined && git(`rev-parse ${heldTwo}^`) === twoTip);
  await page.locator("input.held-message").fill("two: more c");
  await press(page.locator(".held-action", { hasText: "New commit" }));
  check(S, "New commit adds a commit with that message after it", git("log -1 --format=%s two") === "two: more c" && git("rev-parse two^") === twoTip && git("show two:c.ts").endsWith("// more c\n".trimEnd()));
  check(S, "...and the PR above needs restacking", (await page.locator(".stack-restack").innerText().catch(() => "")) === "Rebase 1 upstack");
  await press(page.locator(".stack-restack"));
  check(S, "...then sits on it again", onTop("two", "three"));

  // ---- a one-commit PR, read whole, amended
  await go("three");
  await edit("d.ts", "// more d\n");
  await until(() => held("three"));
  await press(page.locator(".held-action", { hasText: "Amend into" }));
  check(S, "a one-commit PR's edit amends that commit", git("rev-list --count two..three") === "1" && git("show three:d.ts").includes("// more d"));

  // ---- a conflict: nothing moves, the agent is asked, and its fix goes through
  // the line two changed, changed again lower down: line 6, under the comment
  const oneMiddle = git("rev-parse one~1");
  await go("one", oneMiddle);
  await edit(`${oneMiddle}:b.ts`, " by one", { at: 6 });
  await until(() => held("one"));
  await sleep(1000);
  await press(page.locator(".held-action", { hasText: "Amend into" }));
  const twoBefore = git("rev-parse two");
  await page.locator(".stack-restack").click();
  const said = await until(async () => ((await lastToast()).includes("conflict") ? await lastToast() : undefined));
  check(S, "a conflicting restack says so", said !== undefined, JSON.stringify(await toasts(page)));
  check(S, "...and moves nothing", git("rev-parse two") === twoBefore);
  const notes = JSON.parse(readFileSync(join(ROOT, sh(`ls ${ROOT} | grep -- '-pr-one-two-' | head -1`, ROOT).trim(), "notes.json"), "utf8"));
  check(S, "...and asks the agent, in a note on the file", (notes["b.ts"] ?? []).some((note) => (note.messages ?? []).some((message) => message.text.includes("Could you resolve it"))), JSON.stringify(notes).slice(0, 200));
  const resolveDir = join(ROOT, "o-resolve");
  sh(`node ${SKILL}/restack.ts resolve --html ${html} --repo ${repo} --dir ${resolveDir}`, repo);
  const marked = readFileSync(join(resolveDir, "b.ts"), "utf8");
  check(S, "restack.ts sets the conflict up, marked", marked.includes("<<<<<<<") && marked.includes(">>>>>>>"));
  writeFileSync(join(resolveDir, "b.ts"), marked.replace(/<<<<<<<[^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>>[^\n]*\n/, "b5 by one and two\n"));
  sh(`node ${SKILL}/restack.ts resolved --html ${html} --repo ${repo} --dir ${resolveDir}`, repo);
  await press(page.locator(".stack-restack"));
  check(S, "with the agent's resolution, the restack goes through", onTop("one", "two") && git("show two:b.ts").includes("b5 by one and two"));

  // ---- the every-PR review: a commit edited there is held for its own PR
  const allCommits = await page.evaluate(() => JSON.parse(document.getElementById("shell").textContent).reviews.map((review) => review.key));
  check(S, "there is an every-PR review", allCommits.includes("all"));
  const oneFirst = git("rev-parse one~2");
  await go("all", oneFirst);
  await edit(`${oneFirst}:a.ts`, "// from all\n");
  const heldFromAll = await until(() => held("one"));
  check(S, "a commit edited from the every-PR review is held for its own PR", heldFromAll !== undefined && git(`rev-parse ${heldFromAll}^`) === oneFirst);
  await press(page.locator(".held-action", { hasText: "Discard" }));
  check(S, "Discard lets the held edits go", held("one") === "");
  check(S, "...keeping a backup", sh("git for-each-ref refs/guided-review/backup/hold/one", repo).trim() !== "");

  // ---- the checked-out PR: whole-PR rows save to disk, commits are held, and
  // the checkout follows an amend, keeping uncommitted changes
  sh("git checkout -q one", repo);
  writeFileSync(join(repo, "a.ts"), `${readFileSync(join(repo, "a.ts"), "utf8")}// uncommitted\n`);
  await go("one");
  const lastOfOne = git("rev-parse one");
  const checkedMiddle = git("rev-parse one~1");
  await go("one", checkedMiddle);
  await edit(`${checkedMiddle}:b.ts`, "// checked out\n", { at: "start" });
  await until(() => held("one"));
  await press(page.locator(".held-action", { hasText: "Amend into" }));
  check(S, "amending the checked-out PR moves its checkout too", git("rev-parse HEAD") === git("rev-parse one") && git("rev-parse one") !== lastOfOne && readFileSync(join(repo, "b.ts"), "utf8").startsWith("// checked out"));
  check(S, "...keeping its uncommitted changes", readFileSync(join(repo, "a.ts"), "utf8").endsWith("// uncommitted\n"));
  check(S, "...with nothing else showing as changed", sh("git status --porcelain", repo).trim() === "M a.ts", sh("git status --porcelain", repo));

  const unexpected = errors.filter((error) => !error.includes("status of 409"));
  check(S, "no page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- P: held edits in one served PR - its commit bar, disk and history ------ */
const scenarioP = async () => {
  const S = "P";
  const repo = fresh("repo-p");
  gitInit(repo);
  const git = (cmd) => sh(`git ${cmd}`, repo).trim();
  const nine = (prefix, change = {}) => Array.from({ length: 9 }, (_, index) => change[index + 1] ?? `${prefix}${index + 1}`).join("\n") + "\n";
  write(repo, { "x.ts": nine("x"), "y.ts": nine("y") });
  sh("git add -A && git commit -qm base && git checkout -qb feature", repo);
  write(repo, { "x.ts": nine("x", { 2: "x2 first" }) });
  sh("git commit -qam 'first'", repo);
  const first = git("rev-parse HEAD");
  write(repo, { "x.ts": nine("x", { 2: "x2 first", 8: "x8 second" }), "y.ts": nine("y", { 5: "y5 second" }) });
  sh("git commit -qam 'second'", repo);
  const { html } = build(
    repo,
    "p",
    { meta: { title: "P" }, groups: [{ title: "Both", items: [{ path: "x.ts", status: "M" }, { path: "y.ts", status: "M" }] }] },
    `--mode pr --base main --head HEAD --id p-${Date.now()}`,
  );
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  page.on("dialog", (dialog) => void dialog.accept());
  const held = () => sh("git for-each-ref --format='%(objectname)' refs/guided-review/hold/feature", repo).trim();
  const typeInto = async (key, text, line) => {
    const path = key.slice(key.lastIndexOf(":") + 1);
    const toggle = page.locator(`.row[data-path="${path}"] .diff-toggle`).first();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await until(() => model(page, "modified", key));
    await page.evaluate(
      ([key, line]) => {
        const editor = window.monaco.editor.getEditors().find((candidate) => decodeURIComponent(candidate.getModel()?.uri.toString() ?? "") === `inmemory://review/modified/${key}`);
        editor.setPosition({ lineNumber: line, column: editor.getModel().getLineMaxColumn(line) });
        editor.focus();
      },
      [key, line],
    );
    await page.keyboard.type(text);
    await sleep(1800);
  };

  // the checkout's own PR, read whole: still the disk
  await typeInto("y.ts", " on disk", 1);
  check(S, "the checked-out PR read whole still saves to disk", readFileSync(join(repo, "y.ts"), "utf8").startsWith("y1 on disk") && held() === "");
  sh("git checkout -q -- y.ts", repo);
  await sleep(2500);

  // one of its commits, on the commit bar: held
  await until(async () => (await page.locator(".commit-bar .commit-step").count()) >= 3);
  await page.locator(".commit-bar .commit-step", { hasText: first.slice(0, 7) }).click();
  await sleep(2000);
  await typeInto(`${first}:x.ts`, " held", 4);
  check(S, "a commit of the bar holds its edit", (await until(() => held())) !== undefined && git(`rev-parse ${held()}^`) === first);
  check(S, "...leaving the disk alone", !readFileSync(join(repo, "x.ts"), "utf8").includes("held"));

  // the branch moves on under the held edits
  write(repo, { "y.ts": nine("y", { 5: "y5 second", 9: "y9 third" }) });
  sh("git commit -qam 'third'", repo);
  await sleep(3500);
  await page.reload();
  await page.waitForSelector(".row", { state: "attached" });
  await sleep(2500);
  const heldBar = (await page.locator(".held-bar").innerText().catch(() => "")).replace(/\s+/g, " ");
  check(S, "held edits outlast the branch moving on", heldBar.includes(first.slice(0, 7)), heldBar);
  await page.locator("input.held-message").fill("between first and second");
  await Promise.all([page.waitForEvent("load", { timeout: 60_000 }), page.locator(".held-action", { hasText: "New commit" }).click()]);
  await page.waitForSelector(".row", { state: "attached" });
  await sleep(2000);
  check(S, "New commit goes in right after the commit the edits were held against", git("log --format=%s main..feature") === "third\nsecond\nbetween first and second\nfirst", git("log --format=%s main..feature"));
  check(S, "...with every later commit replayed, the newest included", git("show feature:x.ts").includes("x4 held") && git("show feature:x.ts").includes("x8 second") && git("show feature:y.ts").includes("y9 third"));
  check(S, "...and the checkout with it", readFileSync(join(repo, "x.ts"), "utf8").includes("x4 held") && sh("git status --porcelain", repo).trim() === "");
  const steps = (await page.locator(".commit-bar .commit-step").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
  check(S, "the page is rebuilt: its commit bar has the new commit", steps.some((text) => text.includes("between first and second")), JSON.stringify(steps));
  check(S, "nothing is left to restack in a PR alone", (await page.locator(".stack-restack").count()) === 0);
  const unexpected = errors.filter((error) => !error.includes("status of 409"));
  check(S, "no page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- Q: an agent's replies are markdown -------------------------------------- */
const scenarioQ = async () => {
  const S = "Q";
  const repo = fresh("repo-q");
  gitInit(repo);
  write(repo, { "q.ts": "const q = 1;\nconst r = 2;\n" });
  sh("git add . && git commit -qm base && git checkout -qb feature", repo);
  swap(repo, "q.ts", "q = 1", "q = 10");
  sh("git commit -qam change", repo);
  const id = `q-${Date.now()}`;
  const { html } = build(repo, "q", { meta: { title: "Q" }, groups: [{ title: "Q", items: [{ path: "q.ts", status: "M" }] }] }, `--mode pr --base main --head HEAD --id ${id}`);
  const notesFile = join(ROOT, id, "notes.json");
  mkdirSync(join(ROOT, id), { recursive: true });
  writeFileSync(notesFile, JSON.stringify({ "q.ts": [{ line: 1, messages: [{ from: "reviewer", text: "why *this* and **not** `that`?" }] }] }));
  const reply = [
    "Because **ten** is what `parse` expects:",
    "",
    "- it's the base",
    "- it's [documented](https://example.com/docs)",
    "",
    "```",
    "parse(q, 10)",
    "```",
    "",
    "Not [this](javascript:alert(1)), and not <b>raw html</b>.",
  ].join("\n");
  execFileSync(process.execPath, [`${SKILL}/reply.ts`, "--notes", notesFile, "--path", "q.ts", "--line", "1", "--text", reply]);
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  await openDiff(page, "q.ts");
  await until(() => page.locator(".note-from-agent .md").count());
  const agent = page.locator(".note-from-agent .md").first();
  check(S, "an agent's bold is bold", (await agent.locator("strong").first().innerText().catch(() => "")) === "ten");
  check(S, "...its code is code", (await agent.locator("code").first().innerText().catch(() => "")) === "parse");
  check(S, "...its list is a list", (await agent.locator("li").count()) === 2);
  check(S, "...and a fenced block is a block", (await agent.locator("pre").innerText().catch(() => "")).includes("parse(q, 10)"));
  const link = agent.locator("a", { hasText: "documented" });
  check(S, "an agent's link opens in a new tab", (await link.getAttribute("href")) === "https://example.com/docs" && (await link.getAttribute("target")) === "_blank");
  check(S, "...but a javascript: one is no link at all", (await agent.locator('a[href^="javascript"]').count()) === 0 && (await agent.locator(".md-link-refused", { hasText: "this" }).count()) === 1);
  check(S, "...and raw html shows as text, never as html", (await agent.locator("b").count()) === 0 && (await agent.innerText()).includes("<b>raw html</b>"));
  const mine = await page.locator(".note-from-reviewer .note-text").first().innerText().catch(() => "");
  check(S, "the reviewer's own note shows as typed", mine === "why *this* and **not** `that`?", mine);
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

/* ---- R: an edit a note asks for goes where the reviewer's own would ---------- */
const scenarioR = async () => {
  const S = "R";
  const repo = fresh("repo-r");
  gitInit(repo);
  const git = (cmd) => sh(`git ${cmd}`, repo).trim();
  const nine = (prefix, change = {}) => Array.from({ length: 9 }, (_, index) => change[index + 1] ?? `${prefix}${index + 1}`).join("\n") + "\n";
  write(repo, { "x.ts": nine("x") });
  sh("git add -A && git commit -qm base && git checkout -qb feature", repo);
  write(repo, { "x.ts": nine("x", { 2: "x2 first" }) });
  sh("git commit -qam first", repo);
  const first = git("rev-parse HEAD");
  write(repo, { "x.ts": nine("x", { 2: "x2 first", 8: "x8 second" }) });
  sh("git commit -qam second", repo);
  const second = git("rev-parse HEAD");
  sh("git checkout -q main", repo);
  const id = `r-${Date.now()}`;
  const { html } = build(repo, "r", { meta: { title: "R" }, groups: [{ title: "x", items: [{ path: "x.ts", status: "M" }] }] }, `--mode pr --base main --head feature --id ${id}`);
  const notesFile = join(ROOT, id, "notes.json");
  const server = await serve(repo, html);
  const { page, errors } = await open(server.port);
  const held = () => sh("git for-each-ref --format='%(objectname)' refs/guided-review/hold/feature", repo).trim();
  const heldTs = (args) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [`${SKILL}/held.ts`, ...args], { cwd: repo, encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };
  /** writes a note the way a reviewer does: Alt+N on a line, type, Send */
  const writeNote = async (key, line, text) => {
    const path = key.slice(key.lastIndexOf(":") + 1);
    const toggle = page.locator(`.row[data-path="${path}"] .diff-toggle`).first();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await until(() => model(page, "modified", key));
    await page.evaluate(
      ([key, line]) => {
        const editor = window.monaco.editor.getEditors().find((candidate) => decodeURIComponent(candidate.getModel()?.uri.toString() ?? "") === `inmemory://review/modified/${key}`);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      },
      [key, line],
    );
    await page.keyboard.press("Alt+KeyN");
    // the new note's own box takes the focus - an open thread elsewhere has
    // a reply box too, so it is found by focus, not by position
    // (monaco's own input is a textarea too - this is the one in a note zone)
    await until(() => page.evaluate(() => document.activeElement?.closest(".note-zone") != null && document.activeElement.tagName === "TEXTAREA"));
    await page.keyboard.type(text);
    await page.keyboard.press("ControlOrMeta+Enter");
    await sleep(1200);
  };

  // a watching agent hears of the note, with what was being read and how to act
  const watcher = spawn(process.execPath, [`${SKILL}/awaitNotes.ts`, "--notes", notesFile, "--once", "--timeout", "60"], { stdio: ["ignore", "pipe", "pipe"] });
  let heard = "";
  watcher.stdout.on("data", (chunk) => (heard += chunk));
  await sleep(1500);

  await until(async () => (await page.locator(".commit-bar .commit-step").count()) >= 3);
  await page.locator(".commit-bar .commit-step", { hasText: first.slice(0, 7) }).click();
  await sleep(1500);
  await writeNote(`${first}:x.ts`, 4, "make x4 say hello");
  const written = JSON.parse(readFileSync(notesFile, "utf8"))["x.ts"]?.[0]?.messages?.[0];
  check(S, "a note records the commit it was written reading", written?.commit === first, JSON.stringify(written));
  await until(() => heard.includes("new review note"));
  check(S, "the agent is told what the note was reading", heard.includes(`(reading ${first.slice(0, 9)})`), heard.split("\n").slice(0, 3).join(" / "));
  check(S, "...and how to make the edit it asks for", heard.includes("held.ts open") && heard.includes(html), heard.split("\n").slice(2, 4).join(" / "));
  watcher.kill();

  // the agent makes it, into the held edits against that commit
  const dir = join(ROOT, "r-held");
  const opened = heldTs(["open", "--html", html, "--repo", repo, "--notes", notesFile, "--path", "x.ts", "--line", "4", "--dir", dir]);
  check(S, "held.ts opens the PR as of the commit the note was reading", opened.ok && readFileSync(join(dir, "x.ts"), "utf8") === nine("x", { 2: "x2 first" }), opened.out);
  writeFileSync(join(dir, "x.ts"), nine("x", { 2: "x2 first", 4: "x4 hello" }));
  const saved = heldTs(["save", "--dir", dir]);
  check(S, "held.ts save holds the edit against that commit", saved.ok && held() !== "" && git(`rev-parse ${held()}^`) === first, saved.out);
  check(S, "...moving no branch", git("rev-parse feature") === second);
  const shown = await until(async () => (await page.locator(".commit-bar .commit-step", { hasText: "held" }).count()) === 1);
  check(S, "...and the reviewer sees it held, on the commit bar", shown === true);
  const rowNow = await until(async () => ((await model(page, "modified", `${first}:x.ts`))?.includes("x4 hello") ? true : undefined));
  check(S, "...and in the row the note is on", rowNow === true);

  // a note on another commit can't be acted on while edits are held elsewhere
  await page.locator(".commit-bar .commit-step", { hasText: second.slice(0, 7) }).click();
  await sleep(1500);
  await writeNote(`${second}:x.ts`, 8, "and x8 too");
  const refused = heldTs(["open", "--html", html, "--repo", repo, "--notes", notesFile, "--path", "x.ts", "--line", "8", "--dir", join(ROOT, "r-held2")]);
  check(S, "a note on another commit, with edits held elsewhere, is refused, saying why", !refused.ok && refused.out.includes("already held"), refused.out);

  // the checked-out PR read whole: the edit is the disk's
  sh("git checkout -q feature", repo);
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForSelector(".row", { state: "attached" });
  await sleep(1500);
  await writeNote("x.ts", 2, "and x2 on disk");
  const disk = heldTs(["open", "--html", html, "--repo", repo, "--notes", notesFile, "--path", "x.ts", "--line", "2", "--dir", join(ROOT, "r-held3")]);
  check(S, "a note on the checked-out PR read whole is the disk's to change", disk.ok && disk.out.includes("saves to disk") && !existsSync(join(ROOT, "r-held3")), disk.out);
  check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.close();
  server.stop();
};

const scenarios = { R: scenarioR, Q: scenarioQ, P: scenarioP, O: scenarioO, N: scenarioN, M: scenarioM, L: scenarioL, K: scenarioK, J: scenarioJ, I: scenarioI, H: scenarioH, G: scenarioG, A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF };
try {
  browser = await chromium.launch();
} catch (error) {
  console.error(`couldn't start Chromium - install it once with: pnpm exec playwright install chromium\n${error.message}`);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
}
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length > 0 && !only.includes(name)) continue;
  try {
    await run();
  } catch (error) {
    check(name, "ran to the end", false, String(error.message ?? error).split("\n")[0]);
  } finally {
    // a scenario that threw never got to stop its server
    for (const proc of servers.splice(0)) proc.kill();
  }
}
await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length === 0) {
  rmSync(ROOT, { recursive: true, force: true });
} else {
  console.log(`the run's repos, pages and review stores are kept in ${ROOT}`);
}
process.exit(failed.length === 0 ? 0 : 1);
