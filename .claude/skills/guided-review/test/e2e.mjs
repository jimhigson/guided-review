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
import { execSync, spawn } from "node:child_process";
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
  check(S, "on another branch the editors say why they're read-only", hint.includes("the checkout is on main"), hint);
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
    check(S, "per-commit review carries no rebuild recipe", !readFileSync(html, "utf8").includes('id="recipe"'));
    const server = await serve(repo, html);
    const { page, errors } = await open(server.port);
    await page.locator(".row .diff-toggle").first().click();
    await sleep(2500);
    const hint = await page.locator(".editor-bar .hint").first().innerText().catch(() => "");
    check(S, "a commit's diff says it is history", hint.includes("as that commit had it"), hint);
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
    check(S, "stack layer carries no rebuild recipe", !readFileSync(html, "utf8").includes('id="recipe"'));
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
  check(S, "the commit is history", commit.hint.includes("as that commit had it"), commit.hint);

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
    const dir = fresh("stack-l");
    const entry = (key, base) => ({ key, label: key, title: key, url: "", base, head: key });
    writeFileSync(join(dir, "stack.json"), JSON.stringify({ current: "two", entries: [entry("one", "main"), entry("two", "one")] }));
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

    check(S, "a file edited in another PR says which PR and commit", JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 2/2 commit 1/2"]', JSON.stringify(await alsoOf(page, "b.ts")));
    check(S, "a file whose every edit is on the page says nothing", JSON.stringify(await alsoOf(page, "a.ts")) === '["",""]', JSON.stringify(await alsoOf(page, "a.ts")));

    await follow(page, "b.ts", "PR 2/2");
    check(S, "the PR link reads that whole PR", JSON.stringify(where(page)) === '{"review":"two"}', JSON.stringify(where(page)));
    check(S, "...landed on the same file", await landedOn(page, "b.ts"));
    check(S, "...which says where else it is edited, from there", JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 1/2 commit 2/3"]', JSON.stringify(await alsoOf(page, "b.ts")));

    await follow(page, "b.ts", "2/3");
    check(S, "a commit link reads that commit of that PR", where(page).review === "one" && where(page).commit === one2, JSON.stringify(where(page)));
    check(S, "...landed on the same file", await landedOn(page, "b.ts"));

    await page.locator(".commit-bar .commit-step").nth(1).click();
    await sleep(1000);
    check(S, "reading one commit, the file's other commits in the same PR are named", JSON.stringify(await alsoOf(page, "a.ts")) === '["also edited in PR 1/2 commit 3/3"]', JSON.stringify(await alsoOf(page, "a.ts")));
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
    check(S, "reading every PR and every commit, no row says it's edited elsewhere", where(page).review === "all" && everywhere === 0, `${where(page).review}, ${everywhere} lines`);
    await page.locator(".commit-bar .commit-step", { hasText: two1.slice(0, 7) }).first().click();
    await sleep(1000);
    check(S, "reading one commit of every PR, the others are named", JSON.stringify(await alsoOf(page, "b.ts")) === '["also edited in PR 1/2 commit 2/3"]', JSON.stringify(await alsoOf(page, "b.ts")));
    await follow(page, "b.ts", "2/3");
    check(S, "...and linked within the every-PR review", where(page).review === "all" && where(page).commit === one2, JSON.stringify(where(page)));
    check(S, "no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.close();
    server.stop();
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

const scenarios = { L: scenarioL, K: scenarioK, J: scenarioJ, I: scenarioI, H: scenarioH, G: scenarioG, A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF };
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
