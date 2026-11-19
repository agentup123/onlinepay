#!/usr/bin/env bash
# One-time local setup after cloning:
#   - installs dependencies (creates pnpm-lock.yaml)
#   - starts Postgres/Redis/Mailpit
#   - creates the initial Prisma migration and seeds demo data
#   - runs typecheck + unit tests
#   - commits the lockfile and initial migration (push with --push)
#
# Usage: ./scripts/setup.sh [--push]
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1 — $2"; exit 1; }; }
need node "install Node 22 (https://nodejs.org)"
need docker "install Docker Desktop"
command -v pnpm >/dev/null 2>&1 || corepack enable

if [ ! -f .env ]; then
  cp .env.example .env
  # Generate real local secrets instead of the placeholders.
  sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
  sed -i.bak "s/^OTP_PEPPER=.*/OTP_PEPPER=$(openssl rand -hex 32)/" .env
  sed -i.bak "s/^SEED_ADMIN_PASSWORD=.*/SEED_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '\/+=')/" .env
  rm -f .env.bak
  echo "Created .env with generated secrets (see SEED_ADMIN_PASSWORD inside for the admin login)."
fi
ln -sf ../../.env packages/db/.env

pnpm install
docker compose up -d --wait

pnpm db:generate
if [ ! -d packages/db/prisma/migrations ]; then
  pnpm --filter @onlinepay/db exec prisma migrate dev --name init
else
  pnpm db:deploy
fi
pnpm --filter @onlinepay/shared build
pnpm --filter @onlinepay/db build
pnpm db:seed

pnpm typecheck
pnpm test

git add pnpm-lock.yaml packages/db/prisma/migrations 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "chore: add lockfile and initial database migration"
  if [ "${1:-}" = "--push" ]; then git push; fi
fi

echo
echo "Setup complete. Run: pnpm dev"
echo "  Web    http://localhost:3000   Admin  http://localhost:3001"
echo "  API    http://localhost:4000/docs   Mail/SMS  http://localhost:8025"
