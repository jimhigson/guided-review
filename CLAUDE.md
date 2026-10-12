# guided-review

This repo is a Claude Code skill. Everything lives in
`.claude/skills/guided-review/`, and the repo's own layout is a valid install
(see README.md). Its `SKILL.md` is the documentation, for agents *using* the
skill and for changing it. Section 9, "Changing the page itself", covers the
page's internals.

Work from `.claude/skills/guided-review/`. Install with
`pnpm install --ignore-workspace`: the flag and the local `pnpm-workspace.yaml`
stop pnpm treating the skill as a package of whatever repo it sits in.

## Before committing

Run both from `.claude/skills/guided-review/`:

```sh
pnpm check:type
pnpm test:e2e
```

`test/e2e.mjs` checks a *served* review end to end, in headless Chromium
(Playwright), against throwaway repos it makes in the OS temp directory.
It builds a review, serves it on a spare port, and drives the page the way
a reader would: ticks, notes, open diffs, the IDE picker, Space to tick.
It also changes the repo under the open page (edits on disk, `git add`,
commits, rebases, conflicts) and checks the page keeps up. Most of what the
page does only shows in a browser, and most bugs here have been regressions
in some earlier behaviour, so run the whole suite, not just the scenario you
think you touched.

- **Chromium, once:** `pnpm exec playwright install chromium`. Playwright is
  pinned, so its browser stays the same build.
- **Some scenarios:** `pnpm test:e2e G H`. Each scenario is a letter, and the
  file's section headings say what each covers.
- **A real-sized branch (scenario E):** set
  `GR_E2E_BIG_REPO=<a checkout with a big branch>`, plus optionally
  `GR_E2E_BIG_BRANCH` (default: the one checked out) and `GR_E2E_BIG_BASE`
  (default `origin/main`). E clones it, never touching the original, then
  times a build and a rebuild. Without the variable it is skipped.
- **A failing run** prints which check failed and keeps its repos, pages and
  review stores in the temp directory it names. A passing run tidies up.

When you add or change behaviour, add checks for it, named for what they
mean ("a reverted file drops out of view"), so a failure reads as the
behaviour that broke. To be sure a new check would catch the bug it's for,
run it against the version from before the fix too: `GR_SKILL=<a checkout of
the old skill> pnpm test:e2e <scenario>`. Reviews that are meant to start
clean need an id of their own (`--id <name>-${Date.now()}`), because a
review's ticks and notes persist per id, deliberately.
