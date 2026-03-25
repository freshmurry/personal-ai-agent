/**
 * SuperAgent — Production Cloudflare Worker
 *
 * Security layers (in order):
 *   1. Cloudflare Access JWT validation  (Step 3)
 *   2. Rate limiting via KV              (Step 6)
 *   3. ANTHROPIC_API_KEY never leaves server (Step 1)
 *
 * Routes:
 *   POST /api/chat              → Streaming Claude proxy + Workers AI fallback
 *   GET  /api/memory            → Read all memories from D1
 *   POST /api/memory            → Write/update a memory
 *   DELETE /api/memory/:key     → Delete a memory
 *   DELETE /api/memory          → Clear all memories
 *   GET  /api/identity          → Read identity from D1
 *   PUT  /api/identity          → Save identity to D1
 *   GET  /api/history           → Read chat history from D1
 *   POST /api/history           → Save chat history to D1
 *   DELETE /api/history         → Clear history
 *   PUT  /api/files/:key        → Upload file to R2
 *   GET  /api/files/:key        → Download file from R2
 *   DELETE /api/files/:key      → Delete file from R2
 *   GET  /api/files             → List all files in R2
 *   POST /api/automations/trigger → Trigger a Workflow
 *   GET  /auth/callback/:svc    → OAuth 2.0 PKCE callback
 *   POST /webhook/whatsapp      → Twilio WhatsApp webhook
 *   GET  /                      → Serve UI from Assets
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

export { AgentDO, SessionDO } from './durable-objects';
export { AutomationWorkflow } from './workflow';

// ─── Env ─────────────────────────────────────────────────────────────────────
export interface Env {
  // Bindings
  AGENT: DurableObjectNamespace;
  SESSION: DurableObjectNamespace;
  DB: D1Database;
  FILES: R2Bucket;
  VECTORIZE: VectorizeIndex;
  CACHE: KVNamespace;
  OAUTH_STATES: KVNamespace;
  TASK_QUEUE: Queue;
  AUTOMATION_WORKFLOW: Workflow;
  AI: Ai;
  ASSETS: Fetcher;

  // Secrets (loaded from .env via: wrangler secret put KEY)
  ANTHROPIC_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
  GITHUB_CLIENT_ID: string;     GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;     GOOGLE_CLIENT_SECRET: string;
  SLACK_CLIENT_ID: string;      SLACK_CLIENT_SECRET: string;
  LINKEDIN_CLIENT_ID: string;   LINKEDIN_CLIENT_SECRET: string;
  NOTION_CLIENT_ID: string;     NOTION_CLIENT_SECRET: string;
  SALESFORCE_CLIENT_ID: string; SALESFORCE_CLIENT_SECRET: string;
  STRIPE_CLIENT_ID: string;     STRIPE_CLIENT_SECRET: string;
  AIRTABLE_CLIENT_ID: string;   AIRTABLE_CLIENT_SECRET: string;
  HUBSPOT_CLIENT_ID: string;    HUBSPOT_CLIENT_SECRET: string;

  // Cloudflare Access (Zero Trust)
  CF_ACCESS_TEAM_DOMAIN: string;  // e.g. your-team.cloudflareaccess.com
  CF_ACCESS_AUD: string;          // Application AUD tag from Zero Trust dashboard

  // Vars (non-secret, set in wrangler.toml [vars])
  ENVIRONMENT: string;
  WORKER_URL: string;
}

const app = new Hono<{ Bindings: Env }>();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ─── STEP 3: Cloudflare Access JWT Middleware ─────────────────────────────────
// Validates every /api/* request has a valid CF Access JWT.
// In production: Zero Trust → Access → Applications → your Worker URL.
// In development (wrangler dev): skipped automatically.
async function validateCFAccess(request: Request, env: Env): Promise<boolean> {
  // Skip in local dev
  if (env.ENVIRONMENT !== 'production') return true;
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) return true;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return false;

  try {
    // Fetch Cloudflare Access public keys
    const certsUrl = `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
    const certsResp = await fetch(certsUrl);
    const certs = await certsResp.json() as { keys: JsonWebKey[] };

    // Decode JWT header to find key ID
    const [headerB64] = jwt.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const jwk = certs.keys.find((k: any) => k.kid === header.kid);
    if (!jwk) return false;

    // Import the public key and verify signature
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const [, payloadB64, sigB64] = jwt.split('.');
    const sigBuf = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const dataBuf = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBuf, dataBuf);
    if (!valid) return false;

    // Verify audience
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    return payload.aud === env.CF_ACCESS_AUD && payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

// ─── STEP 6: Rate Limiting Middleware ─────────────────────────────────────────
// Sliding window: 60 requests per minute per IP for /api/chat
// 200 requests per minute per IP for other API routes
async function rateLimit(request: Request, env: Env, limit: number): Promise<boolean> {
  if (env.ENVIRONMENT !== 'production') return true;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const window = Math.floor(Date.now() / 60000); // 1-minute window
  const key = `rl:${ip}:${window}`;

  const current = parseInt(await env.CACHE.get(key) || '0', 10);
  if (current >= limit) return false;

  await env.CACHE.put(key, String(current + 1), { expirationTtl: 120 });
  return true;
}

// Auth guard for all /api routes
app.use('/api/*', async (c, next) => {
  const authed = await validateCFAccess(c.req.raw, c.env);
  if (!authed) {
    return c.json({ error: 'Unauthorized. Access through Cloudflare Access only.' }, 401);
  }
  await next();
});

// ─── STEP 1: CHAT — Secure streaming proxy ────────────────────────────────────
// API key NEVER reaches the browser. All calls go through this Worker.
app.post('/api/chat', async (c) => {
  // Rate limit: 60 requests/min for chat
  const allowed = await rateLimit(c.req.raw, c.env, 60);
  if (!allowed) return c.json({ error: 'Rate limit exceeded. Please wait a moment.' }, 429);

  const body = await c.req.json() as {
    messages: Array<{ role: string; content: any }>;
    model?: string;
    max_tokens?: number;
    system?: string;
    stream?: boolean;
  };

  const model = body.model || '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
  const isClaude = model.startsWith('claude-');
  const wantStream = body.stream === true;

  // ── Helper: wrap a plain text reply as a minimal SSE stream ───────────────
  // Workers AI returns a plain string, not SSE. We wrap it so the browser's
  // streaming reader always gets the same format regardless of model.
  function textToSSE(text: string, modelName: string): Response {
    const payload = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    });
    const done = JSON.stringify({ type: 'message_stop' });
    const body = `data: ${payload}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'X-Model': modelName,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ CHAT (NOW WITH AI SEARCH)
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/api/chat', async (c) => {
    const allowed = await rateLimit(c.req.raw, c.env, 60);
    if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);
  
    const body = await c.req.json();
  
    const model = body.model || '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
    const isClaude = model.startsWith('claude-');
    const wantStream = body.stream === true;
  
    // ─────────────────────────────
    // 🔍 AI SEARCH (AutoRAG)
    // ─────────────────────────────
    let ragContext = '';
  
    try {
      const lastUser = [...body.messages].reverse().find((m:any)=>m.role==='user');
  
      if (lastUser) {
        const query =
          typeof lastUser.content === 'string'
            ? lastUser.content
            : JSON.stringify(lastUser.content);
  
        const search = await c.env.AI
          .autorag("highstreet-it") // ✅ YOUR INDEX
          .aiSearch({
            query,
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            rewrite_query: true,
            max_num_results: 3,
            ranking_options: { score_threshold: 0.3 },
            reranking: {
              enabled: true,
              model: "@cf/baai/bge-reranker-base",
            },
          }) as any;
  
        const results = search?.data || search?.results || [];
  
        if (results.length) {
          ragContext = results
            .map((r:any,i:number)=>`Source ${i+1}:\n${r.text || r.content || ''}`)
            .join('\n\n');
        }
      }
    } catch (e) {
      console.warn('[AutoRAG failed]', e);
    }
  
    // Inject into system
    const systemWithRAG = `
  ${body.system || ''}
  
  ${ragContext ? `Use the following context:\n\n${ragContext}` : ''}
  `.trim();
  
  // ── Claude path ────────────────────────────────────────────────────────────
  if (isClaude) {
    if (!c.env.ANTHROPIC_API_KEY) {
      // Key not set — fall through to Workers AI instead of returning an error
      console.warn('[Chat] ANTHROPIC_API_KEY not set, using Workers AI fallback');
    } else {
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': c.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: body.max_tokens || 1000,
            system: body.system || '',
            messages: body.messages,
            stream: wantStream,
          }),
        });

        if (resp.ok) {
          if (wantStream) {
            // Pass SSE stream straight through
            return new Response(resp.body, {
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
              },
            });
          }
          return c.json(await resp.json());
        }

        const err = await resp.json() as any;
        console.error('[Claude] API error:', resp.status, err?.error?.message);
        // Fall through to Workers AI
      } catch (e) {
        console.warn('[Claude] Network error, falling back to Workers AI:', e);
      }
    }
  }

  // ── Cloudflare Workers AI ──────────────────────────────────────────────────
  // Ordered by capability: best first, smallest last.
  // Includes beta models — these may not be available on all accounts yet;
  // we try them in sequence and move to the next on failure.
  const CF_MODELS = model.startsWith('@cf/')
    ? [model]  // user explicitly chose a CF model — try it first
    : [
        '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        '@cf/ibm-granite/granite-4.0-h-micro',
        '@cf/qwen/qwen3-30b-a3b-fp8',
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/meta/llama-3.1-8b-instruct',
        '@cf/mistral/mistral-7b-instruct-v0.1',
      ];

  const systemMsg = body.system
    ? [{ role: 'system' as const, content: body.system }]
    : [];

  const cfMessages = [
    ...systemMsg,
    ...body.messages.map((m: any) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
          : JSON.stringify(m.content),
    })),
  ];

  for (const cfModel of CF_MODELS) {
    try {
      const result = await c.env.AI.run(cfModel as any, {
        messages: cfMessages,
        max_tokens: body.max_tokens || 800,
      }) as any;

      const text: string =
        result?.response ||
        result?.result?.response ||
        result?.choices?.[0]?.message?.content ||
        result?.content ||
        '';

      if (text) {
        if (wantStream) {
          return textToSSE(text, cfModel);
        }
        return c.json({
          content: [{ type: 'text', text }],
          model: cfModel,
          fallback: true,
        });
      }
    } catch (e) {
      console.warn(`[Workers AI] ${cfModel} failed:`, e);
    }
  }

  // Last resort — return a visible error so the bubble is never blank
  const errText = isClaude && !c.env.ANTHROPIC_API_KEY
    ? '⚠️ No API key configured. Add ANTHROPIC_API_KEY as a Cloudflare secret, or switch to a Cloudflare AI model in Settings → Model.'
    : '⚠️ All models failed. Check your Cloudflare Workers AI quota and try again.';

  if (wantStream) return textToSSE(errText, 'error');
  return c.json({ content: [{ type: 'text', text: errText }], error: true }, 200);
});

// ─── STEP 4: MEMORY API (D1) ──────────────────────────────────────────────────
app.get('/api/memory', async (c) => {
  const allowed = await rateLimit(c.req.raw, c.env, 200);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM memory ORDER BY ts DESC'
  ).all();
  return c.json(results);
});

app.post('/api/memory', async (c) => {
  const allowed = await rateLimit(c.req.raw, c.env, 200);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);

  const body = await c.req.json() as { key: string; val: string; type?: string; freq?: number };
  if (!body.key || !body.val) return c.json({ error: 'key and val required' }, 400);

  const key = body.key.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 40);

  await c.env.DB.prepare(`
    INSERT INTO memory (key, val, type, freq, ts, last_access)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      val = excluded.val,
      type = excluded.type,
      freq = memory.freq + 1,
      ts = excluded.ts,
      last_access = excluded.last_access
  `).bind(key, body.val.slice(0, 500), body.type || 'fact', body.freq || 1, Date.now(), Date.now()).run();

  return c.json({ ok: true, key });
});

app.delete('/api/memory/:key', async (c) => {
  await c.env.DB.prepare('DELETE FROM memory WHERE key = ?').bind(c.req.param('key')).run();
  return c.json({ ok: true });
});

app.delete('/api/memory', async (c) => {
  await c.env.DB.prepare('DELETE FROM memory').run();
  return c.json({ ok: true });
});

// ─── IDENTITY API (D1) ────────────────────────────────────────────────────────
app.get('/api/identity', async (c) => {
  const row = await c.env.DB.prepare("SELECT val FROM memory WHERE key = 'identity_blob'").first<{ val: string }>();
  return c.json(row ? JSON.parse(row.val) : {});
});

app.put('/api/identity', async (c) => {
  const body = await c.req.json();
  await c.env.DB.prepare(`
    INSERT INTO memory (key, val, type, freq, ts)
    VALUES ('identity_blob', ?, 'system', 1, ?)
    ON CONFLICT(key) DO UPDATE SET val = excluded.val, ts = excluded.ts
  `).bind(JSON.stringify(body), Date.now()).run();
  return c.json({ ok: true });
});

// ─── HISTORY API (D1) ────────────────────────────────────────────────────────
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT role, content FROM conversations ORDER BY ts ASC LIMIT 100'
  ).all();
  return c.json(results);
});

app.post('/api/history', async (c) => {
  const body = await c.req.json() as { messages: Array<{ role: string; content: string }> };
  // Store only the last 100 turns — replace all
  await c.env.DB.prepare('DELETE FROM conversations').run();
  const stmt = c.env.DB.prepare('INSERT INTO conversations (role, content, ts) VALUES (?, ?, ?)');
  const batch = (body.messages || []).slice(-100).map((m, i) =>
    stmt.bind(m.role, m.content, Date.now() + i)
  );
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true });
});

app.delete('/api/history', async (c) => {
  await c.env.DB.prepare('DELETE FROM conversations').run();
  return c.json({ ok: true });
});

// ─── STEP 4: FILES API (R2) ───────────────────────────────────────────────────
app.get('/api/files', async (c) => {
  const list = await c.env.FILES.list();
  const files = list.objects.map(o => ({
    key: o.key,
    size: o.size,
    uploaded: o.uploaded,
    httpMetadata: o.httpMetadata,
  }));
  return c.json(files);
});

app.put('/api/files/:key{.+}', async (c) => {
  const allowed = await rateLimit(c.req.raw, c.env, 30);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);

  const key = c.req.param('key');
  const body = await c.req.arrayBuffer();
  const contentType = c.req.header('content-type') || 'application/octet-stream';

  await c.env.FILES.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: {
      uploadedAt: new Date().toISOString(),
    },
  });

  // Also log to D1
  await c.env.DB.prepare(`
    INSERT INTO files (name, path, folder, ext, size, r2_key, modified, indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, modified = excluded.modified
  `).bind(
    key.split('/').pop() || key,
    key,
    key.split('/')[0] || 'files',
    (key.split('/').pop() || '').split('.').pop() || '',
    body.byteLength,
    key,
    Date.now()
  ).run();

  return c.json({ ok: true, key, size: body.byteLength });
});

app.get('/api/files/:key{.+}', async (c) => {
  const obj = await c.env.FILES.get(c.req.param('key'));
  if (!obj) return c.json({ error: 'Not found' }, 404);
  return new Response(obj.body, {
    headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream' },
  });
});

app.delete('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key');
  await c.env.FILES.delete(key);
  await c.env.DB.prepare('DELETE FROM files WHERE r2_key = ?').bind(key).run();
  return c.json({ ok: true });
});

// ─── AUTOMATIONS — Cloudflare Workflows ───────────────────────────────────────
app.post('/api/automations/trigger', async (c) => {
  const body = await c.req.json() as { automationId: string; payload?: object };
  const instance = await c.env.AUTOMATION_WORKFLOW.create({
    id: `${body.automationId}_${Date.now()}`,
    params: body.payload || {},
  });
  return c.json({ ok: true, instanceId: instance.id });
});

// ─── STEP 5: OAUTH CALLBACK ───────────────────────────────────────────────────
const OAUTH_CONFIGS: Record<string, { clientId: string; clientSecret: string; tokenUrl: string }> = {};

function getOAuthConfig(env: Env, service: string) {
  const map: Record<string, { id: string; secret: string; tokenUrl: string }> = {
    github:         { id: env.GITHUB_CLIENT_ID,     secret: env.GITHUB_CLIENT_SECRET,     tokenUrl: 'https://github.com/login/oauth/access_token' },
    gmail:          { id: env.GOOGLE_CLIENT_ID,      secret: env.GOOGLE_CLIENT_SECRET,      tokenUrl: 'https://oauth2.googleapis.com/token' },
    googledocs:     { id: env.GOOGLE_CLIENT_ID,      secret: env.GOOGLE_CLIENT_SECRET,      tokenUrl: 'https://oauth2.googleapis.com/token' },
    googlecalendar: { id: env.GOOGLE_CLIENT_ID,      secret: env.GOOGLE_CLIENT_SECRET,      tokenUrl: 'https://oauth2.googleapis.com/token' },
    googledrive:    { id: env.GOOGLE_CLIENT_ID,      secret: env.GOOGLE_CLIENT_SECRET,      tokenUrl: 'https://oauth2.googleapis.com/token' },
    slack:          { id: env.SLACK_CLIENT_ID,       secret: env.SLACK_CLIENT_SECRET,       tokenUrl: 'https://slack.com/api/oauth.v2.access' },
    linkedin:       { id: env.LINKEDIN_CLIENT_ID,    secret: env.LINKEDIN_CLIENT_SECRET,    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' },
    notion:         { id: env.NOTION_CLIENT_ID,      secret: env.NOTION_CLIENT_SECRET,      tokenUrl: 'https://api.notion.com/v1/oauth/token' },
    salesforce:     { id: env.SALESFORCE_CLIENT_ID,  secret: env.SALESFORCE_CLIENT_SECRET,  tokenUrl: 'https://login.salesforce.com/services/oauth2/token' },
    stripe:         { id: env.STRIPE_CLIENT_ID,      secret: env.STRIPE_CLIENT_SECRET,      tokenUrl: 'https://connect.stripe.com/oauth/token' },
    airtable:       { id: env.AIRTABLE_CLIENT_ID,    secret: env.AIRTABLE_CLIENT_SECRET,    tokenUrl: 'https://airtable.com/oauth2/v1/token' },
    hubspot:        { id: env.HUBSPOT_CLIENT_ID,     secret: env.HUBSPOT_CLIENT_SECRET,     tokenUrl: 'https://api.hubapi.com/oauth/v1/token' },
  };
  return map[service];
}

app.get('/auth/callback/:service', async (c) => {
  const service = c.req.param('service');
  const code    = c.req.query('code');
  const error   = c.req.query('error');

  if (error || !code) {
    return new Response(oauthCallbackPage(service, null, error || 'missing_code'), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Exchange code for token server-side (keeps client_secret off the browser)
  const cfg = getOAuthConfig(c.env, service);
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let expiresIn: number | null = null;

  if (cfg) {
    try {
      const redirectUri = `${c.env.WORKER_URL}/auth/callback/${service}`;
      const tokenResp = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: new URLSearchParams({
          client_id: cfg.id,
          client_secret: cfg.secret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenResp.json() as any;
      accessToken  = tokenData.access_token || null;
      refreshToken = tokenData.refresh_token || null;
      expiresIn    = tokenData.expires_in || null;

      // Store token securely in D1 (encrypted at rest by Cloudflare)
      if (accessToken) {
        await c.env.DB.prepare(`
          INSERT INTO oauth_tokens (service, access_token, refresh_token, expires_at, created)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(service) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at
        `).bind(
          service,
          accessToken,
          refreshToken || '',
          expiresIn ? Date.now() + expiresIn * 1000 : null,
          Date.now()
        ).run();
      }
    } catch (e) {
      console.error('[OAuth] Token exchange failed:', service, e);
    }
  }

  return new Response(oauthCallbackPage(service, code, null), {
    headers: { 'Content-Type': 'text/html' },
  });
});

function oauthCallbackPage(service: string, code: string | null, error: string | null): string {
  const success = !!code && !error;
  return `<!DOCTYPE html>
<html>
<head><title>${success ? 'Connected' : 'Error'}</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F5F3EE}</style>
</head>
<body>
<script>
  const msg = ${JSON.stringify({ type: 'oauth_callback', service, code, error })};
  if (window.opener) {
    window.opener.postMessage(msg, '*');
    document.body.innerHTML = '<div style="text-align:center"><div style="font-size:32px;margin-bottom:12px">${success ? '✓' : '✗'}</div><div style="font-size:14px;color:#6B7280">${success ? 'Connected! This window will close.' : 'Authorization failed: ' + error}</div></div>';
    setTimeout(() => window.close(), 1500);
  } else {
    document.body.innerHTML = '<div style="text-align:center;padding:40px"><div style="font-size:14px;color:#6B7280">${success ? '✓ Authorized. You can close this tab.' : '✗ Failed: ' + error}</div></div>';
  }
<\/script>
</body></html>`;
}

// ─── WHATSAPP WEBHOOK (Twilio) ────────────────────────────────────────────────
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.parseBody() as Record<string, string>;
  const incomingMsg = body.Body || '';
  const from        = body.From || '';
  if (!incomingMsg) return c.text('', 200);

  let reply = '';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'You are a personal AI superagent responding via WhatsApp. Be concise — plain text only, no markdown.',
        messages: [{ role: 'user', content: incomingMsg }],
      }),
    });
    const d = await resp.json() as any;
    reply = d.content?.[0]?.text || "Sorry, I'm having trouble right now.";
  } catch {
    reply = "Connection issue — try again in a moment.";
  }

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${c.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${c.env.TWILIO_ACCOUNT_SID}:${c.env.TWILIO_AUTH_TOKEN}`)}`,
      },
      body: new URLSearchParams({ From: c.env.TWILIO_WHATSAPP_NUMBER, To: from, Body: reply }),
    }
  );

  return new Response('<?xml version="1.0"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' },
  });
});

// ─── SERVE UI ─────────────────────────────────────────────────────────────────
app.get('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

// ─── CRON + QUEUE ─────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log('[Cron]', event.cron);
    ctx.waitUntil(
      env.AUTOMATION_WORKFLOW.create({
        id: `cron_${Date.now()}`,
        params: { trigger: 'cron', cron: event.cron },
      })
    );
  },

  async queue(batch: MessageBatch<any>, env: Env) {
    for (const msg of batch.messages) {
      console.log('[Queue]', msg.body);
      msg.ack();
    }
  },
};
