# guided-review

A Claude Code skill that builds an ordered, locally-served HTML reading order
for a large commit, PR or working tree — every file's diff embedded inline in
an editable Monaco editor, grouped by theme, with per-line review notes and a
pan/zoom compare viewer for changed images. Self-contained: no dependency on
whichever repo is being reviewed.

See [`SKILL.md`](.claude/skills/guided-review/SKILL.md) for what it does and
how to use it once installed.

## Install

Using the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add jimhigson/guided-review
```

For Claude Code specifically, installing straight into a project's
`.claude/skills/`:

```sh
npx skills add jimhigson/guided-review -a claude-code
```

Add `-g`/`--global` to either command to install into `~/.claude/skills/`
instead of the current project.

### Without the CLI

This repo's own layout is already a valid `.claude/skills/guided-review/`
directory, so cloning it into a project's `.claude` folder (or symlinking it
in) works just as well:

```sh
git clone https://github.com/jimhigson/guided-review .claude/skills/guided-review
```
