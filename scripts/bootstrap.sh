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
NEXT STEPS (manual). The numbering matches docs/SETUP.md.

  SETUP.md step 3  Paste database_id above into wrangler.jsonc
  SETUP.md step 4  wrangler secret put OWNER_TOKEN_SECRET
                   (use: openssl rand -base64 32)
  SETUP.md step 5  bun run migrate:remote
  SETUP.md step 6  Configure the Cloudflare Access applications, then set
                   ACCESS_TEAM_DOMAIN / ACCESS_AUD / OWNER_HOST / MCP_HOST in
                   wrangler.jsonc. Leave ACCESS_MCP_AUD blank here.
  SETUP.md step 7  bun run deploy
  SETUP.md step 8  CLI setup (service token env vars)
  SETUP.md step 9  docs/MCP-OAUTH-RUNBOOK.md. Required before the MCP endpoint
                   serves anything: while ACCESS_MCP_AUD is blank, POST /mcp on
                   the MCP hostname answers 503. Every other path on that
                   hostname answers 404 either way.
EOF
