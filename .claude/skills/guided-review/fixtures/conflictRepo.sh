#!/usr/bin/env bash
# A throwaway repo paused mid-merge (or mid-rebase) with its conflicts already
# resolved - the way an agent leaves one - for trying the conflict review on
# without a real project to hand.
#
#   fixtures/conflictRepo.sh <dir> [merge|rebase]
#
# <dir> is created (and must not exist yet). What it holds, and what the
# resolution does to each file, so there is something known to look for:
#
#   src/pricing.ts        both sides changed the same function - conflicted.
#                         The resolution keeps both changes, drops current's
#                         audit log line, and adds a clamp of its own
#   config.json           both sides changed the same key - conflicted. The
#                         resolution takes incoming's value outright
#   src/featureFlags.ts   both sides added this file - an add/add conflict,
#                         resolved as a union of the two flag lists
#   src/pages/profile.ts  incoming adds a call to fetchUser, which current
#                         renamed to loadUser. git merges it cleanly, and the
#                         result would not compile, so the resolution renames
#                         the call - "edited past merge"
#   src/api/client.ts     only current changed it (the rename) - merged
#                         cleanly and left alone, so it is not in the review
#   README.md             only incoming changed it - likewise not in the review
#   src/checkout/basket.ts   incoming moved src/basket.ts here, and both
#                         sides changed addLine - conflicted, at the new path.
#                         Current's side of it is at the old path
#   src/format/units.ts   the same the other way round: current moved
#                         src/units.ts here, so incoming's side is at the old
#                         path
set -euo pipefail

dir="${1:?usage: conflictRepo.sh <dir> [merge|rebase]}"
operation="${2:-merge}"
if [[ -e "$dir" ]]; then
  echo "$dir already exists - pick a fresh directory" >&2
  exit 1
fi
if [[ "$operation" != merge && "$operation" != rebase ]]; then
  echo "operation must be merge or rebase, not $operation" >&2
  exit 64
fi

mkdir -p "$dir"
cd "$dir"
git init --quiet --initial-branch=main
git config user.name "Fixture"
git config user.email "fixture@example.invalid"
git config commit.gpgsign false

mkdir -p src/api src/pages

# ---- the common ancestor -------------------------------------------------
cat > src/pricing.ts <<'EOF'
export type LineItem = { sku: string; unitPrice: number; quantity: number };

export const subtotal = (items: LineItem[]): number =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

export const total = (items: LineItem[], taxRate: number): number => {
  const net = subtotal(items);
  const tax = net * taxRate;
  return net + tax;
};

export const formatPrice = (amount: number): string => `£${amount.toFixed(2)}`;
EOF

cat > src/api/client.ts <<'EOF'
export type User = { id: string; name: string; email: string };

export const fetchUser = async (id: string): Promise<User> => {
  const response = await fetch(`/api/users/${id}`);
  return (await response.json()) as User;
};
EOF

cat > src/pages/profile.ts <<'EOF'
import { fetchUser } from "../api/client.ts";

export const renderProfile = async (id: string): Promise<string> => {
  const user = await fetchUser(id);
  return `<h1>${user.name}</h1>`;
};
EOF

cat > config.json <<'EOF'
{
  "retries": 3,
  "timeoutMs": 5000,
  "region": "eu-west-2"
}
EOF

cat > README.md <<'EOF'
# shop

A small shop.
EOF

cat > src/basket.ts <<'EOF'
export type Basket = { lines: { sku: string; quantity: number }[] };

export const emptyBasket = (): Basket => ({ lines: [] });

export const addLine = (basket: Basket, sku: string, quantity: number): Basket => ({
  lines: [...basket.lines, { sku, quantity }],
});

export const lineCount = (basket: Basket): number => basket.lines.length;

export const itemCount = (basket: Basket): number =>
  basket.lines.reduce((sum, line) => sum + line.quantity, 0);
EOF

cat > src/units.ts <<'EOF'
export const grams = (kg: number): number => kg * 1000;

export const formatWeight = (grams: number): string =>
  grams >= 1000 ? `${grams / 1000}kg` : `${grams}g`;

export const formatVolume = (ml: number): string =>
  ml >= 1000 ? `${ml / 1000}l` : `${ml}ml`;

export const formatLength = (mm: number): string =>
  mm >= 1000 ? `${mm / 1000}m` : `${mm}mm`;
EOF

git add -A
git commit --quiet -m "the common ancestor"

# ---- incoming: the feature branch -----------------------------------------
git switch --quiet -c feature

cat > src/pricing.ts <<'EOF'
export type LineItem = { sku: string; unitPrice: number; quantity: number };

export const subtotal = (items: LineItem[]): number =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

/** tax is rounded to the penny before it is added, as HMRC expects */
export const total = (items: LineItem[], taxRate: number): number => {
  const net = subtotal(items);
  const tax = Math.round(net * taxRate * 100) / 100;
  return net + tax;
};

export const formatPrice = (amount: number): string => `£${amount.toFixed(2)}`;
EOF

cat > src/pages/profile.ts <<'EOF'
import { fetchUser } from "../api/client.ts";

export const renderProfile = async (id: string): Promise<string> => {
  const user = await fetchUser(id);
  return `<h1>${user.name}</h1>`;
};

export const renderProfileEmail = async (id: string): Promise<string> => {
  const user = await fetchUser(id);
  return `<a href="mailto:${user.email}">${user.email}</a>`;
};
EOF

cat > config.json <<'EOF'
{
  "retries": 3,
  "timeoutMs": 8000,
  "region": "eu-west-2"
}
EOF

cat > src/featureFlags.ts <<'EOF'
export const featureFlags = {
  roundedTax: true,
  profileEmail: true,
};
EOF

cat >> README.md <<'EOF'

Prices include VAT, rounded to the penny.
EOF

mkdir -p src/checkout
git mv src/basket.ts src/checkout/basket.ts
cat > src/checkout/basket.ts <<'EOF'
export type Basket = { lines: { sku: string; quantity: number }[] };

export const emptyBasket = (): Basket => ({ lines: [] });

/** adding a sku already in the basket tops up its line */
export const addLine = (basket: Basket, sku: string, quantity: number): Basket =>
  basket.lines.some((line) => line.sku === sku) ?
    { lines: basket.lines.map((line) => (line.sku === sku ? { sku, quantity: line.quantity + quantity } : line)) }
  : { lines: [...basket.lines, { sku, quantity }] };

export const lineCount = (basket: Basket): number => basket.lines.length;

export const itemCount = (basket: Basket): number =>
  basket.lines.reduce((sum, line) => sum + line.quantity, 0);
EOF

cat > src/units.ts <<'EOF'
export const grams = (kg: number): number => kg * 1000;

export const formatWeight = (grams: number): string =>
  grams >= 1000 ? `${grams / 1000} kg` : `${grams} g`;

export const formatVolume = (ml: number): string =>
  ml >= 1000 ? `${ml / 1000}l` : `${ml}ml`;

export const formatLength = (mm: number): string =>
  mm >= 1000 ? `${mm / 1000}m` : `${mm}mm`;
EOF

git add -A
git commit --quiet -m "round tax to the penny; show the profile email"

cat > src/pages/settings.ts <<'EOF'
export const renderSettings = (): string => "<h1>Settings</h1>";
EOF
git add -A
git commit --quiet -m "a settings page"

# ---- current: main moves on -----------------------------------------------
git switch --quiet main

cat > src/pricing.ts <<'EOF'
export type LineItem = { sku: string; unitPrice: number; quantity: number };

export const subtotal = (items: LineItem[]): number =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

export const total = (items: LineItem[], taxRate: number, discount = 0): number => {
  const net = subtotal(items) - discount;
  const tax = net * taxRate;
  console.info("pricing.total", { net, tax, discount });
  return net + tax;
};

export const formatPrice = (amount: number): string => `£${amount.toFixed(2)}`;
EOF

cat > src/api/client.ts <<'EOF'
export type User = { id: string; name: string; email: string };

export const loadUser = async (id: string): Promise<User> => {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) {
    throw new Error(`user ${id}: ${response.status}`);
  }
  return (await response.json()) as User;
};
EOF

cat > src/pages/profile.ts <<'EOF'
import { loadUser } from "../api/client.ts";

export const renderProfile = async (id: string): Promise<string> => {
  const user = await loadUser(id);
  return `<h1>${user.name}</h1>`;
};
EOF

cat > config.json <<'EOF'
{
  "retries": 3,
  "timeoutMs": 6000,
  "region": "eu-west-2"
}
EOF

cat > src/featureFlags.ts <<'EOF'
export const featureFlags = {
  discounts: true,
};
EOF

cat > src/basket.ts <<'EOF'
export type Basket = { lines: { sku: string; quantity: number }[] };

export const emptyBasket = (): Basket => ({ lines: [] });

export const addLine = (basket: Basket, sku: string, quantity: number): Basket => {
  if (quantity <= 0) {
    throw new Error(`can't add ${quantity} of ${sku}`);
  }
  return { lines: [...basket.lines, { sku, quantity }] };
};

export const lineCount = (basket: Basket): number => basket.lines.length;

export const itemCount = (basket: Basket): number =>
  basket.lines.reduce((sum, line) => sum + line.quantity, 0);
EOF

mkdir -p src/format
git mv src/units.ts src/format/units.ts
cat > src/format/units.ts <<'EOF'
export const grams = (kg: number): number => kg * 1000;

export const formatWeight = (grams: number): string =>
  grams >= 1000 ? `${(grams / 1000).toFixed(1)}kg` : `${grams}g`;

export const formatVolume = (ml: number): string =>
  ml >= 1000 ? `${ml / 1000}l` : `${ml}ml`;

export const formatLength = (mm: number): string =>
  mm >= 1000 ? `${mm / 1000}m` : `${mm}mm`;
EOF

git add -A
git commit --quiet -m "discounts; loadUser checks the response"

# ---- the conflict ----------------------------------------------------------
if [[ "$operation" == merge ]]; then
  git merge --quiet --no-edit feature >/dev/null 2>&1 || true
else
  git switch --quiet feature
  git rebase main >/dev/null 2>&1 || true
fi

# ---- the resolution, as an agent might leave it -----------------------------
cat > src/pricing.ts <<'EOF'
export type LineItem = { sku: string; unitPrice: number; quantity: number };

export const subtotal = (items: LineItem[]): number =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

/** tax is rounded to the penny before it is added, as HMRC expects */
export const total = (items: LineItem[], taxRate: number, discount = 0): number => {
  const net = Math.max(subtotal(items) - discount, 0);
  const tax = Math.round(net * taxRate * 100) / 100;
  return net + tax;
};

export const formatPrice = (amount: number): string => `£${amount.toFixed(2)}`;
EOF

cat > config.json <<'EOF'
{
  "retries": 3,
  "timeoutMs": 8000,
  "region": "eu-west-2"
}
EOF

cat > src/featureFlags.ts <<'EOF'
export const featureFlags = {
  discounts: true,
  roundedTax: true,
  profileEmail: true,
};
EOF

cat > src/pages/profile.ts <<'EOF'
import { loadUser } from "../api/client.ts";

export const renderProfile = async (id: string): Promise<string> => {
  const user = await loadUser(id);
  return `<h1>${user.name}</h1>`;
};

export const renderProfileEmail = async (id: string): Promise<string> => {
  const user = await loadUser(id);
  return `<a href="mailto:${user.email}">${user.email}</a>`;
};
EOF

mkdir -p src/checkout src/format
cat > src/checkout/basket.ts <<'EOF'
export type Basket = { lines: { sku: string; quantity: number }[] };

export const emptyBasket = (): Basket => ({ lines: [] });

/** adding a sku already in the basket tops up its line */
export const addLine = (basket: Basket, sku: string, quantity: number): Basket => {
  if (quantity <= 0) {
    throw new Error(`can't add ${quantity} of ${sku}`);
  }
  return basket.lines.some((line) => line.sku === sku) ?
      { lines: basket.lines.map((line) => (line.sku === sku ? { sku, quantity: line.quantity + quantity } : line)) }
    : { lines: [...basket.lines, { sku, quantity }] };
};

export const lineCount = (basket: Basket): number => basket.lines.length;

export const itemCount = (basket: Basket): number =>
  basket.lines.reduce((sum, line) => sum + line.quantity, 0);
EOF

cat > src/format/units.ts <<'EOF'
export const grams = (kg: number): number => kg * 1000;

export const formatWeight = (grams: number): string =>
  grams >= 1000 ? `${(grams / 1000).toFixed(1)} kg` : `${grams} g`;

export const formatVolume = (ml: number): string =>
  ml >= 1000 ? `${ml / 1000}l` : `${ml}ml`;

export const formatLength = (mm: number): string =>
  mm >= 1000 ? `${mm / 1000}m` : `${mm}mm`;
EOF
# git can leave the old path behind beside a conflicted rename
rm -f src/basket.ts src/units.ts

git add -A

echo "$dir: $operation paused with its conflicts resolved and staged"
git status --short
