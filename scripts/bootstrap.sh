#!/usr/bin/env bash
set -euo pipefail

# Create poof's D1 database and R2 bucket if they do not exist.
# Wrangler exit codes identify existing resources, so reruns leave them untouched
# without requiring jq.

# D1
if wrangler d1 info poof-db >/dev/null 2>&1; then
  echo "d1 poof-db: exists"
else
  wrangler d1 create poof-db
fi

# R2
if wrangler r2 bucket info poof-blobs >/dev/null 2>&1; then
  echo "r2 poof-blobs: exists"
else
  wrangler r2 bucket create poof-blobs
fi

# Print the database_id for wrangler.jsonc
wrangler d1 info poof-db

cat <<'EOF'
NEXT STEPS (manual):
  1. Paste database_id above into wrangler.jsonc
  2. wrangler secret put OWNER_TOKEN_SECRET   (use: openssl rand -base64 32)
  3. Set ACCESS_TEAM_DOMAIN / ACCESS_AUD vars in wrangler.jsonc
  4. Configure Cloudflare Access apps per docs/SETUP.md
  5. bun run migrate:remote && bun run deploy
EOF
