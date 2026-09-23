#!/usr/bin/env bash
# A throwaway repo holding a three-layer `gh stack` that exists only locally -
# no remote, no PRs - for trying a stack review on before any of it is pushed.
#
#   fixtures/localStack.sh <dir>
#
# <dir> is created (and must not exist yet). The stack, trunk first:
#
#   (main) <- auth <- api <- ui
#
# auth adds token signing, api serves routes with it, ui logs in against those
# routes. Each layer is one branch with one commit, and `gh stack view --json`
# reports them with no `pr` of their own - which is what `resolveStack.ts
# --stack` turns into a reviewable stack.
#
# Two files are touched by more than one layer - src/auth/token.ts (auth, then
# api) and src/api/routes.ts (api, then ui) - so a review of every layer at
# once has something to gather notes from.
#
# Needs the gh-stack extension: gh extension install github/gh-stack
set -euo pipefail

dir="${1:?usage: localStack.sh <dir>}"
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

mkdir -p src/auth src/api src/ui

cat > README.md <<'EOF'
# shop

A small shop, built in layers.
EOF
cat > src/config.ts <<'EOF'
export const config = { sessionMinutes: 60 };
EOF
git add -A
git commit --quiet -m "the trunk"

# ---- layer 1: auth ---------------------------------------------------------
git switch --quiet -c auth
cat > src/auth/token.ts <<'EOF'
import { config } from "../config.ts";

export type Token = { subject: string; expiresAt: number };

export const issue = (subject: string, now = Date.now()): Token => ({
  subject,
  expiresAt: now + config.sessionMinutes * 60_000,
});

export const isValid = (token: Token, now = Date.now()): boolean => token.expiresAt > now;
EOF
cat > src/auth/token.test.ts <<'EOF'
import { isValid, issue } from "./token.ts";

const token = issue("alice", 0);
if (!isValid(token, 0)) {
  throw new Error("a fresh token should be valid");
}
if (isValid(token, 60 * 60_000 + 1)) {
  throw new Error("an hour-old token should have expired");
}
EOF
git add -A
git commit --quiet -m "Sign and check session tokens"

# ---- layer 2: api ----------------------------------------------------------
git switch --quiet -c api
cat > src/api/routes.ts <<'EOF'
import { isValid, issue, type Token } from "../auth/token.ts";

export type Request = { path: string; body?: { subject?: string }; token?: Token };

export const handle = (request: Request): { status: number; body?: unknown } => {
  if (request.path === "/login") {
    const subject = request.body?.subject;
    return subject === undefined ?
        { status: 400 }
      : { status: 200, body: issue(subject) };
  }
  if (request.token === undefined || !isValid(request.token)) {
    return { status: 401 };
  }
  return { status: 200, body: { subject: request.token.subject } };
};
EOF
cat > src/api/routes.test.ts <<'EOF'
import { handle } from "./routes.ts";

if (handle({ path: "/login" }).status !== 400) {
  throw new Error("a login with no subject is a bad request");
}
if (handle({ path: "/me" }).status !== 401) {
  throw new Error("an unauthenticated request is refused");
}
EOF

# the routes need the subject back out of a token, so this layer reaches down
# into the layer below it
cat > src/auth/token.ts <<'EOF'
import { config } from "../config.ts";

export type Token = { subject: string; expiresAt: number };

export const issue = (subject: string, now = Date.now()): Token => ({
  subject,
  expiresAt: now + config.sessionMinutes * 60_000,
});

export const isValid = (token: Token, now = Date.now()): boolean => token.expiresAt > now;

/** who a token is for, or nobody once it has expired */
export const subjectOf = (token: Token, now = Date.now()): string | undefined =>
  isValid(token, now) ? token.subject : undefined;
EOF
git add -A
git commit --quiet -m "Serve /login and /me"

# ---- layer 3: ui -----------------------------------------------------------
git switch --quiet -c ui
cat > src/ui/LoginForm.ts <<'EOF'
import { handle } from "../api/routes.ts";

export const submitLogin = (subject: string): string => {
  const response = handle({ path: "/login", body: { subject } });
  return response.status === 200 ? `welcome, ${subject}` : "that didn't work";
};
EOF
cat > src/config.ts <<'EOF'
export const config = { sessionMinutes: 60, loginPath: "/login" };
EOF

# and the form wants the login path from config rather than a literal
cat > src/api/routes.ts <<'EOF'
import { isValid, issue, subjectOf, type Token } from "../auth/token.ts";
import { config } from "../config.ts";

export type Request = { path: string; body?: { subject?: string }; token?: Token };

export const handle = (request: Request): { status: number; body?: unknown } => {
  if (request.path === config.loginPath) {
    const subject = request.body?.subject;
    return subject === undefined ?
        { status: 400 }
      : { status: 200, body: issue(subject) };
  }
  if (request.token === undefined || !isValid(request.token)) {
    return { status: 401 };
  }
  return { status: 200, body: { subject: subjectOf(request.token) } };
};
EOF
git add -A
git commit --quiet -m "A login form over the api"

# ---- make it a stack -------------------------------------------------------
gh stack init auth api ui >/dev/null

echo "$dir: a local-only stack"
gh stack view --short 2>/dev/null || gh stack view --json
