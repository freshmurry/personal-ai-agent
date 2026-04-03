import { Hono } from 'hono';
import { cors } from 'hono/cors';

/**
 * SuperAgent — Integrated Worker Controller
 * Source of Truth: D1 Database
 * Storage: R2 Bucket
 * Logic: Cloudflare Workflows, Vectorize, Queues
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
<<<<<<< HEAD

/**
 * SuperAgent — Integrated Worker Controller
 * ...
 */
=======
import { SuperAgent } from './agent/engine';
import { FileIntelligence } from './agent/file-intelligence';
import { AgentDO, SessionDO } from './durable-objects';
import { AutomationWorkflow } from './workflow';
import type { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import type { MessageBatch } from '@cloudflare/workers-types';
>>>>>>> 6fe3cff (Updated index.ts with SessionsDO code)

export class SessionDO {
  state: DurableObjectState;
  env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST') {
      const data = await request.json();
      await this.state.storage.put('data', data);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'GET') {
      const data = await this.state.storage.get('data');
      return new Response(JSON.stringify({ data }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('SessionDO OK');
  }
}

type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  OAUTH_STATES: KVNamespace;
  AUTOMATION_WORKFLOW: Workflow;
  VECTORIZE: VectorizeIndex;
  MY_QUEUE: Queue;
  SESSION: DurableObjectNamespace;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
  ANTHROPIC_API_KEY: string;
  ASSETS: { fetch: typeof fetch };
  AI: any;
};

<<<<<<< HEAD
const app = new Hono<{ Bindings: Bindings }>();
type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  OAUTH_STATES: KVNamespace;
  AUTOMATION_WORKFLOW: Workflow;
  VECTORIZE: VectorizeIndex;
  MY_QUEUE: Queue;
  SESSION: DurableObjectNamespace; // Kept SessionDO as per wrangler.toml
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
  ANTHROPIC_API_KEY: string;
  ASSETS: { fetch: typeof fetch };
  AI: any;
};
=======
  // Cloudflare Access (Zero Trust)
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: string;  // e.g. your-team.cloudflareaccess.com
  CLOUDFLARE_ACCESS_AUD: string;          // Application AUD tag from Zero Trust dashboard
>>>>>>> 6fe3cff (Updated index.ts with SessionsDO code)

const app = new Hono<{ Bindings: Bindings }>();

// 1. GLOBAL MIDDLEWARE: CORS & RATE LIMITING
app.use('*', cors());

<<<<<<< HEAD
app.use('/api/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const limitKey = `rate:${ip}`;
  
  const current = await c.env.CACHE.get(limitKey);
  const count = parseInt(current || '0');

  if (count > 100) {
    return c.json({ error: 'Rate limit exceeded. Please wait a minute.' }, 429);
  }

  await c.env.CACHE.put(limitKey, (count + 1).toString(), { expirationTtl: 60 });
  await next();
});

// 2. SERVE UI (Cloudflare Assets)
app.get('/', async (c) => c.env.ASSETS.fetch(c.req.raw));

// 3. IDENTITY & MEMORY API (D1 + Vectorize Sync)
app.get('/api/identity', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM memory WHERE type = 'identity' ORDER BY ts DESC"
  ).all();
=======
// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ─── STEP 3: Cloudflare Access JWT Middleware ─────────────────────────────────
// Validates every /api/* request has a valid CF Access JWT.
// In production: Zero Trust → Access → Applications → your Worker URL.
// In development (wrangler dev): skipped automatically.
async function validateCFAccess(request: Request, env: Env): Promise<boolean> {
  // Skip in local dev
  if (env.ENVIRONMENT !== 'production') return true;
  if (!env.CLOUDFLARE_ACCESS_AUD || !env.CLOUDFLARE_ACCESS_TEAM_DOMAIN) return true;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return false;

  try {
    // Fetch Cloudflare Access public keys
    const certsUrl = `https://${env.CLOUDFLARE_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
    const certsResp = await fetch(certsUrl);
    const certs = await certsResp.json() as { keys: JsonWebKey[] };

    // Decode JWT header to find key ID
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const header = JSON.parse(decodeBase64(headerB64));
    const jwk = certs.keys.find(k => k.kid === header.kid);
    if (!jwk) return false;

    // Import the public key and verify signature
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sigBuf = Uint8Array.from(decodeBase64(sigB64), c => c.charCodeAt(0));
    const dataBuf = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBuf, dataBuf);
    if (!valid) return false;

    // Verify audience
    const payload = JSON.parse(decodeBase64(payloadB64));
    return payload.aud === env.CLOUDFLARE_ACCESS_AUD && payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

function decodeBase64(str: string) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  str += '='.repeat((4 - (str.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(str), c => c.charCodeAt(0)));
}

// ─── STEP 6: Rate Limiting Middleware ─────────────────────────────────────────
// Sliding window: 60 requests per minute per IP for /api/chat
// 200 requests per minute per IP for other API routes
async function rateLimit(request: Request, env: Env, limit: number): Promise<boolean> {
  if (env.ENVIRONMENT !== 'production') return true;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const window = Math.floor(Date.now() / 60000);
  const key = `rl:${ip}:${window}`;

  const current = parseInt(await env.CACHE.get(key) || '0', 10);
  if (current >= limit) return false;

  await env.CACHE.put(key, String(current + 1), { expirationTtl: 120 });
  return true;
}

// Auth guard for all /api routes
app.use('/api/*', async (c, next) => {
  const authed = await validateCFAccess(c.req.raw, c.env);
  if (!authed) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

// ─── STEP 1: CHAT — Secure streaming proxy ────────────────────────────────────
// API key NEVER reaches the browser. All calls go through this Worker.
app.post('/api/chat', async (c) => {
  const agent = new SuperAgent(c.env);
  const body = await c.req.json();
  const response = await agent.run({
    userId: "default",
    sessionId: "session",
    query: body.messages.at(-1)?.content
  });
  return c.json({ response });
});

// ─── STEP 2: MEMORY API (D1) ──────────────────────────────────────────────────
app.get('/api/memory', async (c) => {
  const allowed = await rateLimit(c.req.raw, c.env, 200);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);
  const { results } = await c.env.DB.prepare('SELECT * FROM memory ORDER BY ts DESC').all();
>>>>>>> 6fe3cff (Updated index.ts with SessionsDO code)
  return c.json(results);
});

app.post('/api/memory', async (c) => {
<<<<<<< HEAD
  const { key, val, type } = await c.req.json();
  const ts = Date.now();
  
  // A. SQL Persistence
=======
  const allowed = await rateLimit(c.req.raw, c.env, 200);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);

  const body = await c.req.json() as { key: string; val: string; type?: string; freq?: number };
  if (!body.key || !body.val) return c.json({ error: 'key and val required' }, 400);

  const key = body.key.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 40);
>>>>>>> 6fe3cff (Updated index.ts with SessionsDO code)
  await c.env.DB.prepare(`
    INSERT INTO memory (key, val, type, ts) 
    VALUES (?, ?, ?, ?) 
    ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts
  `).bind(key, val, type || 'fact', ts).run();

  // B. Vector Embedding (Semantic Search)
  // This allows the Agent to use "semantic search" as a tool later
  const embedding = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [val] });
  await c.env.VECTORIZE.upsert([{
    id: key,
    values: embedding.data[0],
    metadata: { type: type || 'fact', text: val }
  }]);

  return c.json({ success: true });
});

// 4. HISTORY API (D1)
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM conversations ORDER BY ts DESC LIMIT 100"
  ).all();
  return c.json(results);
});

<<<<<<< HEAD
// 5. FILES API (R2 Storage + D1 Metadata Sync)
app.put('/api/files/:name', async (c) => {
  const name = c.req.param('name');
  const blob = await c.req.blob();
  const ext = name.split('.').pop() || '';
  
  await c.env.FILES.put(name, blob);
  
=======
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

  import { FileIntelligence } from './agent/file-intelligence';

  const fi = new FileIntelligence(c.env);
  await fi.processFile(key, body);

  // Also log to D1
>>>>>>> 6fe3cff (Updated index.ts with SessionsDO code)
  await c.env.DB.prepare(`
    INSERT INTO files (name, path, folder, ext, size, modified) 
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET size=excluded.size, modified=excluded.modified
  `).bind(name, `/api/files/${name}`, 'root', ext, blob.size, Date.now()).run();

  return c.json({ success: true, path: `/api/files/${name}` });
});

app.get('/api/files/:name', async (c) => {
  const object = await c.env.FILES.get(c.req.param('name'));
  if (!object) return c.notFound();
  
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  
  return new Response(object.body, { headers });
});

// 6. SESSION PROXY (For SessionDO)
app.all('/session/:id/*', async (c) => {
  const id = c.env.SESSION.idFromName(c.req.param('id'));
  const obj = c.env.SESSION.get(id);
  return obj.fetch(c.req.raw);
});

// 7. OAUTH CALLBACK
app.get('/auth/callback/:service', async (c) => {
  const service = c.req.param('service');
  const { code, state } = c.req.query();

  const storedState = await c.env.OAUTH_STATES.get(`state:${service}`);
  if (!state || state !== storedState) return c.text('OAuth CSRF Warning', 403);

  const mockAccessToken = `tok_${crypto.randomUUID()}`;
  
  await c.env.DB.prepare(`
    INSERT INTO oauth_tokens (service, access_token, created) 
    VALUES (?, ?, ?)
    ON CONFLICT(service) DO UPDATE SET access_token=excluded.access_token, created=excluded.created
  `).bind(service, mockAccessToken, Date.now()).run();

  return c.redirect('/?auth=success');
});

// 8. WHATSAPP WEBHOOK (Twilio + Queue)
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.parseBody();
  const from = body.From as string;
  const text = body.Body as string;

  await c.env.MY_QUEUE.send({
    type: 'whatsapp_message',
    from,
    text,
    ts: Date.now()
  });

  return c.text('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
    'Content-Type': 'text/xml',
  });
});

// 9. EXPORTS
export default {
  fetch: app.fetch,
<<<<<<< HEAD

  async scheduled(event: ScheduledEvent, env: Bindings) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM automations WHERE active = 1 AND cron = ?"
    ).bind(event.cron).all();
    
    for (const auto of results) {
      await env.AUTOMATION_WORKFLOW.create({
        params: { 
          trigger: 'cron', 
          instructions: auto.instructions as string,
          notify: auto.notify as string
        }
      });
    }
  },

  async queue(batch: MessageBatch<any>, env: Bindings) {
    for (const message of batch.messages) {
      const data = message.body;
      
      if (data.type === 'whatsapp_message') {
        await env.AUTOMATION_WORKFLOW.create({
          params: { 
            trigger: 'whatsapp', 
            payload: { sender: data.from, message: data.text },
            instructions: "Process WhatsApp message from queue."
          }
        });
      }
    }
  }
};
=======
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.AUTOMATION_WORKFLOW.create({
      id: `cron_${Date.now()}`,
      params: { trigger: 'cron', cron: event.cron },
    }));
  },
  async queue(batch: MessageBatch<any>, env: Env) {
    for (const msg of batch.messages) {
      console.log('[Queue]', msg.body);
      msg.ack();
    }
  },
};
>>>>>>> 6fe3cff (Updated index.ts with SessionsDO code)
