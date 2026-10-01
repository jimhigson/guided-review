#!/usr/bin/env bash
# A throwaway repo whose stack has several commits per PR, for trying a review
# read commit by commit.
#
#   fixtures/commitStack.sh <dir>
#
# <dir> is created (and must not exist yet). The stack, trunk first:
#
#   (main) <- parsing <- rendering
#
# parsing has three commits, rendering two, and two files are touched by more
# than one commit - src/parse/tokenise.ts (twice in parsing) and
# src/render/table.ts (twice in rendering) - so reading every commit at once
# has the same file in it twice, each time with that commit's own diff.
#
# Needs the gh-stack extension: gh extension install github/gh-stack
set -euo pipefail

dir="${1:?usage: commitStack.sh <dir>}"
if [[ -e "$dir" ]]; then
  echo "$dir already exists - pick a fresh directory" >&2
  exit 1
fi
if ! gh stack --help >/dev/null 2>&1; then
  echo "gh stack is not installed - run: gh extension install github/gh-stack" >&2
  exit 1
fi

mkdir -p "$dir"
cd "$dir"
git init --quiet --initial-branch=main
git config user.name "Fixture"
git config user.email "fixture@example.invalid"
git config commit.gpgsign false

mkdir -p src/parse src/render

cat > README.md <<'EOF'
# tinymark

A very small markdown subset, parsed then rendered.
EOF
git add -A
git commit --quiet -m "the trunk"

# ---- PR 1: parsing --------------------------------------------------------
git switch --quiet -c parsing

cat > src/parse/tokenise.ts <<'EOF'
export type Token = { kind: "text" | "hash"; text: string };

export const tokenise = (line: string): Token[] =>
  line.startsWith("#") ?
    [
      { kind: "hash", text: line.slice(0, line.indexOf(" ")) },
      { kind: "text", text: line.slice(line.indexOf(" ") + 1) },
    ]
  : [{ kind: "text", text: line }];
EOF
git add -A
git commit --quiet -m "Tokenise a line into hashes and text"

cat > src/parse/block.ts <<'EOF'
import { tokenise, type Token } from "./tokenise.ts";

export type Block = { kind: "heading"; level: number; text: string } | { kind: "para"; text: string };

export const parseBlock = (line: string): Block => {
  const [first, rest] = tokenise(line) as [Token, Token | undefined];
  return first.kind === "hash" && rest !== undefined ?
      { kind: "heading", level: first.text.length, text: rest.text }
    : { kind: "para", text: first.text };
};
EOF
git add -A
git commit --quiet -m "Parse a line into a heading or a paragraph"

cat > src/parse/tokenise.ts <<'EOF'
export type Token = { kind: "text" | "hash" | "star"; text: string };

const leading = (line: string, char: string): string => {
  let count = 0;
  while (line[count] === char) {
    count += 1;
  }
  return line.slice(0, count);
};

export const tokenise = (line: string): Token[] => {
  const hashes = leading(line, "#");
  if (hashes !== "" && line[hashes.length] === " ") {
    return [
      { kind: "hash", text: hashes },
      { kind: "text", text: line.slice(hashes.length + 1) },
    ];
  }
  // *emphasis* is a token of its own, so the renderer needn't re-scan the text
  return line.includes("*") ?
      [{ kind: "star", text: line }]
    : [{ kind: "text", text: line }];
};
EOF
git add -A
git commit --quiet -m "Recognise emphasis while tokenising"

# ---- PR 2: rendering ------------------------------------------------------
git switch --quiet -c rendering

cat > src/render/html.ts <<'EOF'
import { type Block } from "../parse/block.ts";

export const renderBlock = (block: Block): string =>
  block.kind === "heading" ?
    `<h${block.level}>${block.text}</h${block.level}>`
  : `<p>${block.text}</p>`;
EOF
cat > src/render/table.ts <<'EOF'
export const renderRow = (cells: string[]): string =>
  `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
EOF
git add -A
git commit --quiet -m "Render blocks, and a bare table row"

cat > src/render/table.ts <<'EOF'
export type Align = "left" | "right";

export const renderRow = (cells: string[], align: Align[] = []): string =>
  `<tr>${cells
    .map((cell, index) => {
      const style = align[index] === "right" ? ' style="text-align:right"' : "";
      return `<td${style}>${cell}</td>`;
    })
    .join("")}</tr>`;

export const renderTable = (rows: string[][], align: Align[] = []): string =>
  `<table>${rows.map((row) => renderRow(row, align)).join("")}</table>`;
EOF
git add -A
git commit --quiet -m "Align table columns, and render whole tables"

gh stack init parsing rendering >/dev/null

echo "$dir: a stack of 2 PRs, 5 commits"
git log --oneline --graph --all | head -12
