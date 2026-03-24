#!/bin/bash
# setup-cloudflare.sh
# Runs once before your first deploy. Creates all Cloudflare resources
# and patches wrangler.toml with the real IDs automatically.
#
# Usage:
#   chmod +x setup-cloudflare.sh
#   ./setup-cloudflare.sh

set -e
echo "🚀 SuperAgent — Cloudflare resource setup"
echo ""

# ── D1 ───────────────────────────────────────────────────────────────────────
echo "Creating D1 database..."
D1_OUTPUT=$(wrangler d1 create superagent-db 2>&1)
echo "$D1_OUTPUT"
D1_ID=$(echo "$D1_OUTPUT" | grep 'database_id' | grep -oP '"[a-f0-9-]{36}"' | tr -d '"' | head -1)

if [ -z "$D1_ID" ]; then
  # Already exists — fetch existing
  D1_ID=$(wrangler d1 list --json 2>/dev/null | grep -A2 '"superagent-db"' | grep uuid | grep -oP '"[a-f0-9-]{36}"' | tr -d '"' | head -1)
fi

if [ -n "$D1_ID" ]; then
  sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$D1_ID/" wrangler.toml
  echo "✅  D1 id: $D1_ID"
else
  echo "⚠️  Could not auto-detect D1 id — paste it manually in wrangler.toml"
fi

# ── R2 ───────────────────────────────────────────────────────────────────────
echo ""
echo "Creating R2 bucket..."
wrangler r2 bucket create superagent-files 2>&1 || echo "(may already exist)"
echo "✅  R2 bucket: superagent-files"

# ── Vectorize ─────────────────────────────────────────────────────────────────
echo ""
echo "Creating Vectorize index..."
wrangler vectorize create superagent-knowledge \
  --dimensions=768 --metric=cosine 2>&1 || echo "(may already exist)"
echo "✅  Vectorize: superagent-knowledge"

# ── KV ────────────────────────────────────────────────────────────────────────
echo ""
echo "Creating KV namespaces..."

CACHE_OUTPUT=$(wrangler kv namespace create CACHE 2>&1)
echo "$CACHE_OUTPUT"
CACHE_ID=$(echo "$CACHE_OUTPUT" | grep -oP '"id":\s*"[a-f0-9]+"' | grep -oP '"[a-f0-9]{32}"' | tr -d '"' | head -1)
if [ -z "$CACHE_ID" ]; then
  CACHE_ID=$(wrangler kv namespace list --json 2>/dev/null | grep -B1 '"CACHE"' | grep id | grep -oP '"[a-f0-9]{32}"' | tr -d '"' | head -1)
fi
if [ -n "$CACHE_ID" ]; then
  sed -i "s/REPLACE_WITH_CACHE_KV_ID/$CACHE_ID/" wrangler.toml
  echo "✅  CACHE KV id: $CACHE_ID"
else
  echo "⚠️  Paste CACHE KV id manually in wrangler.toml"
fi

OAUTH_OUTPUT=$(wrangler kv namespace create OAUTH_STATES 2>&1)
echo "$OAUTH_OUTPUT"
OAUTH_ID=$(echo "$OAUTH_OUTPUT" | grep -oP '"id":\s*"[a-f0-9]+"' | grep -oP '"[a-f0-9]{32}"' | tr -d '"' | head -1)
if [ -z "$OAUTH_ID" ]; then
  OAUTH_ID=$(wrangler kv namespace list --json 2>/dev/null | grep -B1 '"OAUTH_STATES"' | grep id | grep -oP '"[a-f0-9]{32}"' | tr -d '"' | head -1)
fi
if [ -n "$OAUTH_ID" ]; then
  sed -i "s/REPLACE_WITH_OAUTH_STATES_KV_ID/$OAUTH_ID/" wrangler.toml
  echo "✅  OAUTH_STATES KV id: $OAUTH_ID"
else
  echo "⚠️  Paste OAUTH_STATES KV id manually in wrangler.toml"
fi

# ── Queue ─────────────────────────────────────────────────────────────────────
echo ""
echo "Creating queue..."
wrangler queues create superagent-tasks 2>&1 || echo "(may already exist)"
echo "✅  Queue: superagent-tasks"

# ── D1 Schema ─────────────────────────────────────────────────────────────────
echo ""
echo "Creating D1 tables..."
wrangler d1 execute superagent-db --file=src/db/schema.sql --remote
echo "✅  Tables created"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "✅  Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Check wrangler.toml — confirm all IDs were filled in"
echo "  2. Update WORKER_URL in wrangler.toml [vars]"
echo "  3. cp .env.example .env  →  fill in your secrets"
echo "  4. npm run secrets:push"
echo "  5. npm run deploy"
echo "═══════════════════════════════════════"
