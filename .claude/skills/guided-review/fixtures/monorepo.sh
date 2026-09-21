#!/usr/bin/env bash
# A throwaway monorepo with uncommitted changes across several packages, for
# seeing how a review shows paths inside packages without a real one to hand.
#
#   fixtures/monorepo.sh <dir>
#
# <dir> is created (and must not exist yet). The workspace has a root
# package.json (the workspace itself - never shown as a package), two
# packages under packages/, an app under apps/ whose name differs from its
# directory, and a changed root file that belongs to no package. Review it in
# worktree mode.
set -euo pipefail

dir="${1:?usage: monorepo.sh <dir>}"
if [[ -e "$dir" ]]; then
  echo "$dir already exists - pick a fresh directory" >&2
  exit 1
fi

mkdir -p "$dir"
cd "$dir"
git init --quiet --initial-branch=main
git config user.name "Fixture"
git config user.email "fixture@example.invalid"
git config commit.gpgsign false

mkdir -p packages/core/src/money packages/ui/src/components apps/storefront/src/pages

cat > package.json <<'EOF'
{ "name": "shop-workspace", "private": true, "workspaces": ["packages/*", "apps/*"] }
EOF
cat > tsconfig.base.json <<'EOF'
{ "compilerOptions": { "strict": true, "target": "ES2022" } }
EOF

cat > packages/core/package.json <<'EOF'
{ "name": "@shop/core", "version": "1.0.0" }
EOF
cat > packages/core/src/money/format.ts <<'EOF'
export const formatPrice = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
EOF
cat > packages/core/src/index.ts <<'EOF'
export { formatPrice } from "./money/format.ts";
EOF

cat > packages/ui/package.json <<'EOF'
{ "name": "@shop/ui", "version": "1.0.0" }
EOF
cat > packages/ui/src/components/PriceTag.tsx <<'EOF'
import { formatPrice } from "@shop/core";

export const PriceTag = ({ pence }: { pence: number }) => <span>{formatPrice(pence)}</span>;
EOF

cat > apps/storefront/package.json <<'EOF'
{ "name": "@shop/storefront-app", "private": true }
EOF
cat > apps/storefront/src/pages/basket.tsx <<'EOF'
import { PriceTag } from "@shop/ui/src/components/PriceTag.tsx";

export const Basket = ({ total }: { total: number }) => <PriceTag pence={total} />;
EOF

git add -A
git commit --quiet -m "the workspace"

# ---- the change: currency support, across every package -------------------
cat > packages/core/src/money/format.ts <<'EOF'
export type Currency = "GBP" | "EUR";

const symbols: Record<Currency, string> = { GBP: "£", EUR: "€" };

export const formatPrice = (pence: number, currency: Currency = "GBP"): string =>
  `${symbols[currency]}${(pence / 100).toFixed(2)}`;
EOF
cat > packages/core/src/index.ts <<'EOF'
export { type Currency, formatPrice } from "./money/format.ts";
EOF
cat > packages/core/src/money/currency.test.ts <<'EOF'
import { formatPrice } from "./format.ts";

if (formatPrice(250, "EUR") !== "€2.50") {
  throw new Error("euros");
}
EOF

cat > packages/ui/src/components/PriceTag.tsx <<'EOF'
import { type Currency, formatPrice } from "@shop/core";

export const PriceTag = ({ pence, currency }: { pence: number; currency?: Currency }) => (
  <span class="price">{formatPrice(pence, currency)}</span>
);
EOF

cat > apps/storefront/src/pages/basket.tsx <<'EOF'
import { type Currency } from "@shop/core";
import { PriceTag } from "@shop/ui/src/components/PriceTag.tsx";

export const Basket = ({ total, currency }: { total: number; currency: Currency }) => (
  <PriceTag pence={total} currency={currency} />
);
EOF

cat > tsconfig.base.json <<'EOF'
{ "compilerOptions": { "strict": true, "target": "ES2022", "jsx": "preserve" } }
EOF

echo "$dir: a monorepo with uncommitted changes in three packages and the root"
git status --short
