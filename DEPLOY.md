# SuperAgent — Production Deployment Guide

Follow these steps in order. Each step depends on the previous.

---

## Prerequisites

```bash
npm install -g wrangler
wrangler login
```

---

## Step 1 — API Key Protection ✅ (already done in code)

The Anthropic API key **never touches the browser**. All AI calls go through:

```
Browser → /api/chat → Cloudflare Worker → Anthropic API
                         ↑
                    key lives here as a secret
```

You do not need to do anything for this step — the code is already wired correctly.

---

## Step 2 — Deploy the Worker

### 2a. Create Cloudflare resources

Run each command and copy the ID into `wrangler.toml`:

```bash
# Get your account ID
wrangler whoami
# → paste into wrangler.toml: account_id = "..."

# D1 database
wrangler d1 create superagent-db
# → paste database_id into wrangler.toml [[d1_databases]]

# R2 bucket
wrangler r2 bucket create superagent-files

# Vectorize index (768 dims for bge-base-en-v1.5)
wrangler vectorize create superagent-knowledge \
  --dimensions=768 --metric=cosine

# KV namespaces
wrangler kv namespace create CACHE
wrangler kv namespace create OAUTH_STATES
# → paste both IDs into wrangler.toml [[kv_namespaces]]

# Task queue
wrangler queues create superagent-tasks
```

### 2b. Fill in wrangler.toml

```toml
account_id = "PASTE_HERE"
WORKER_URL  = "https://superagent.YOUR_SUBDOMAIN.workers.dev"

[[d1_databases]]
database_id = "PASTE_HERE"

[[kv_namespaces]]  # CACHE
id = "PASTE_HERE"

[[kv_namespaces]]  # OAUTH_STATES
id = "PASTE_HERE"
```

### 2c. Set up secrets

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY and anything else you need
```

Push secrets to Cloudflare (one at a time or in bulk):

```bash
# One at a time:
echo "sk-ant-YOUR_KEY" | wrangler secret put ANTHROPIC_API_KEY

# Or push everything from .env at once:
npm run secrets:push
```

### 2d. Create the D1 tables

```bash
wrangler d1 execute superagent-db \
  --file=src/db/schema.sql \
  --remote
```

### 2e. Build and deploy

```bash
mkdir -p public
cp la-ui.html public/index.html
npm install
npm run deploy
```

Your Worker is live at:
`https://superagent.YOUR_SUBDOMAIN.workers.dev`

---

## Step 3 — Lock with Cloudflare Access (most important security step)

This makes your app **completely private** — only you can reach it.

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Fill in:
   - **Name:** SuperAgent
   - **Domain:** `superagent.YOUR_SUBDOMAIN.workers.dev`
4. Click **Next** → **Add a policy**
5. Policy name: `Owner only`
6. Action: **Allow**
7. Include rule: **Emails** → add your email address
8. Click **Save**

Now get your Access credentials and add them as secrets:

```bash
# From Zero Trust → Settings → General → "Team domain"
echo "your-team.cloudflareaccess.com" | wrangler secret put CF_ACCESS_TEAM_DOMAIN

# From Zero Trust → Access → Applications → your app → "Application Audience (AUD) Tag"  
echo "YOUR_AUD_TAG" | wrangler secret put CF_ACCESS_AUD
```

Test it: open your Worker URL in an incognito window — you should see a Cloudflare Access login page before the app loads.

---

## Step 4 — Backend Persistence ✅ (already done in code)

The UI uses a **write-through pattern**:

- **localStorage** = instant local cache (UI never waits)
- **/api/memory, /api/history, /api/files** = durable server storage

When you're on the live HTTPS domain, every save automatically syncs to:
- D1 (memory, identity, history)
- R2 (files)

On load, the app hydrates from the server — so your data survives browser cache clears.

---

## Step 5 — Set Up OAuth Connectors

For each service you want, create an OAuth app and add the credentials as secrets.

### GitHub

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**
2. Homepage URL: `https://superagent.YOUR_SUBDOMAIN.workers.dev`
3. **Callback URL: `https://superagent.YOUR_SUBDOMAIN.workers.dev/auth/callback/github`**
4. Register, then copy Client ID + generate Client Secret

```bash
echo "YOUR_CLIENT_ID" | wrangler secret put GITHUB_CLIENT_ID
echo "YOUR_CLIENT_SECRET" | wrangler secret put GITHUB_CLIENT_SECRET
```

Also update the `clientId` in the HTML's `CONN_CATALOG` for GitHub:
```js
{id:'github', clientId:'YOUR_GITHUB_CLIENT_ID', ...}
```

### Google (Gmail, Docs, Calendar, Drive)

1. [console.cloud.google.com](https://console.cloud.google.com) → New project
2. **APIs & Services** → Enable: Gmail API, Google Docs API, Google Calendar API, Drive API
3. **OAuth consent screen** → External → add your email as test user
4. **Credentials** → Create OAuth 2.0 Client ID → Web application
5. Authorized redirect URIs — add one for each Google service:
   - `https://superagent.YOUR_SUBDOMAIN.workers.dev/auth/callback/gmail`
   - `https://superagent.YOUR_SUBDOMAIN.workers.dev/auth/callback/googledocs`
   - `https://superagent.YOUR_SUBDOMAIN.workers.dev/auth/callback/googlecalendar`
   - `https://superagent.YOUR_SUBDOMAIN.workers.dev/auth/callback/googledrive`

```bash
echo "YOUR_CLIENT_ID" | wrangler secret put GOOGLE_CLIENT_ID
echo "YOUR_CLIENT_SECRET" | wrangler secret put GOOGLE_CLIENT_SECRET
```

Update the HTML `clientId` for all four Google connectors.

### Slack

1. [api.slack.com/apps](https://api.slack.com/apps) → Create App → From scratch
2. **OAuth & Permissions** → Add redirect URL:
   `https://superagent.YOUR_SUBDOMAIN.workers.dev/auth/callback/slack`
3. Bot Token Scopes: `channels:read`, `chat:write`, `users:read`, `files:read`
4. Install to workspace

```bash
echo "YOUR_CLIENT_ID" | wrangler secret put SLACK_CLIENT_ID
echo "YOUR_CLIENT_SECRET" | wrangler secret put SLACK_CLIENT_SECRET
```

### WhatsApp (Twilio)

1. [twilio.com](https://www.twilio.com) → Messaging → Try WhatsApp → Sandbox
2. Set webhook URL: `https://superagent.YOUR_SUBDOMAIN.workers.dev/webhook/whatsapp`
3. Set "When a message comes in" to HTTP POST

```bash
echo "YOUR_ACCOUNT_SID" | wrangler secret put TWILIO_ACCOUNT_SID
echo "YOUR_AUTH_TOKEN" | wrangler secret put TWILIO_AUTH_TOKEN
echo "whatsapp:+14155238886" | wrangler secret put TWILIO_WHATSAPP_NUMBER
```

---

## Step 6 — Rate Limiting ✅ (already done in code)

The Worker enforces:
- `/api/chat` → **60 requests/minute** per IP
- Other API routes → **200 requests/minute** per IP
- File uploads → **30 requests/minute** per IP

Returns `429 Too Many Requests` when exceeded. Implemented via KV sliding window counter.

---

## Step 7 — End-to-End Testing

Run through this checklist after deployment:

```
□ App loads behind Cloudflare Access (shows login page in incognito)
□ Chat sends a message → streams a response → no Anthropic key visible in DevTools
□ Memory saves ("My name is [your name]") → refreshes page → memory persists from D1
□ Upload a file → appears in Files panel → check R2 bucket in Cloudflare dashboard
□ Connect one OAuth service (GitHub or Slack) → real OAuth redirect → token stored
□ WhatsApp: send activation code → message your Worker number → get a reply
□ Check rate limiting: send >60 messages quickly → receive a 429
□ Check logs: wrangler tail → should see requests, no errors
```

### Verify API key is protected

Open Chrome DevTools → Network tab → send a chat message.
You should see a request to `/api/chat` on your own domain — **not** to `api.anthropic.com`.
Your key is safe.

---

## Local Development

```bash
# .env is loaded automatically
npm run dev
# → http://localhost:8787
```

In dev mode:
- Cloudflare Access validation is **skipped**
- Rate limiting is **skipped**
- D1/R2/KV use local emulators via Miniflare

---

## Ongoing Maintenance

```bash
# Rotate the API key
echo "NEW_KEY" | wrangler secret put ANTHROPIC_API_KEY

# View live logs
wrangler tail

# Deploy an update
npm run deploy

# Check D1 data
wrangler d1 execute superagent-db --command="SELECT * FROM memory LIMIT 10" --remote
```

---

## File Structure

```
superagent/
├── .env                 ← secrets (gitignored)
├── .env.example         ← template (committed)
├── .gitignore           ← .env excluded
├── wrangler.toml        ← config (no secrets)
├── package.json
├── tsconfig.json
├── la-ui.html           ← source UI
├── public/
│   └── index.html       ← built UI (copy of la-ui.html)
├── scripts/
│   └── push-secrets.mjs ← bulk secret pusher
└── src/
    ├── index.ts         ← main Worker (all API routes)
    ├── durable-objects.ts
    ├── workflow.ts
    └── db/
        └── schema.sql
```

---

## Security Checklist

- [x] ANTHROPIC_API_KEY proxied through Worker — never in browser
- [x] All secrets in `.env`, pushed via `wrangler secret put`, never in `wrangler.toml`
- [x] `.env` in `.gitignore`
- [x] Cloudflare Access JWT validation on all `/api/*` routes
- [x] Rate limiting: 60 req/min for chat, 200 for other routes
- [x] Files served from Cloudflare edge (no origin server exposure)
- [ ] Set up Cloudflare Access (Step 3 — do this before sharing the URL)
- [ ] Enable Cloudflare WAF rules for your worker domain (Dashboard → Security → WAF)
- [ ] Set up Cloudflare Bot Fight Mode (Dashboard → Security → Bots)
