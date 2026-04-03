import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { SuperAgent } from './agent/engine';
import { FileIntelligence } from './agent/file-intelligence';
import { AutomationWorkflow } from './workflow';
export { AutomationWorkflow };
export { AgentDO, SessionDO } from './durable-objects';

import type {
  ScheduledEvent,
  ExecutionContext,
  MessageBatch,
} from '@cloudflare/workers-types';

/* ─────────────────────────────────────────────────────────────────────────────
   Bindings (must match wrangler.toml exactly)
───────────────────────────────────────────────────────────────────────────── */
export type Bindings = {
  // Core storage
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  OAUTH_STATES: KVNamespace;

  // AI + Vector
  AI: any;
  VECTORIZE: VectorizeIndex;

  // Durable Objects
  SESSION: DurableObjectNamespace;

  // Workflows / Queues
  AUTOMATION_WORKFLOW: Workflow;
  MY_QUEUE: Queue;

  // Assets
  ASSETS: { fetch: typeof fetch };

  // Env vars
  ENVIRONMENT: 'development' | 'production';
  ANTHROPIC_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;

  // Cloudflare Access (Zero Trust)
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: string;
  CLOUDFLARE_ACCESS_AUD: string;
};

/* ─────────────────────────────────────────────────────────────────────────────
   App setup
───────────────────────────────────────────────────────────────────────────── */
const app = new Hono<{ Bindings: Bindings }>();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

/* ─────────────────────────────────────────────────────────────────────────────
   Cloudflare Access validation
───────────────────────────────────────────────────────────────────────────── */
async function validateCFAccess(
  request: Request,
  env: Bindings,
): Promise<boolean> {
  if (env.ENVIRONMENT !== 'production') return true;
  if (!env.CLOUDFLARE_ACCESS_AUD || !env.CLOUDFLARE_ACCESS_TEAM_DOMAIN)
    return true;

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return false;

  try {
    const certsUrl = `https://${env.CLOUDFLARE_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
    const certsResp = await fetch(certsUrl);
    const { keys } = (await certsResp.json()) as { keys: JsonWebKey[] };

    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const header = JSON.parse(atob(headerB64));
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      sig,
      data,
    );
    if (!valid) return false;

    const payload = JSON.parse(atob(payloadB64));
    return payload.aud === env.CLOUDFLARE_ACCESS_AUD;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Rate limiting (KV)
───────────────────────────────────────────────────────────────────────────── */
async function rateLimit(
  request: Request,
  env: Bindings,
  limit: number,
): Promise<boolean> {
  if (env.ENVIRONMENT !== 'production') return true;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const window = Math.floor(Date.now() / 60000);
  const key = `rl:${ip}:${window}`;

  const current = parseInt((await env.CACHE.get(key)) || '0', 10);
  if (current >= limit) return false;

  await env.CACHE.put(key, String(current + 1), { expirationTtl: 120 });
  return true;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Auth guard for API
───────────────────────────────────────────────────────────────────────────── */
app.use('/api/*', async (c, next) => {
  const ok = await validateCFAccess(c.req.raw, c.env);
  if (!ok) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

/* ─────────────────────────────────────────────────────────────────────────────
   CHAT API
───────────────────────────────────────────────────────────────────────────── */
app.post('/api/chat', async (c) => {
  const allowed = await rateLimit(c.req.raw, c.env, 60);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);

  const body = await c.req.json();
  const agent = new SuperAgent(c.env);

  const result = await agent.run({
    userId: 'default',
    sessionId: 'session',
    query: body.messages?.at(-1)?.content ?? '',
  });

  return c.json({ response: result });
});

/* ─────────────────────────────────────────────────────────────────────────────
   HISTORY + MEMORY
───────────────────────────────────────────────────────────────────────────── */
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM conversations ORDER BY ts DESC LIMIT 100',
  ).all();
  return c.json(results);
});

app.post('/api/memory', async (c) => {
  const body = await c.req.json();
  const ts = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO memory (key, val, type, ts)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts`,
  )
    .bind(body.key, body.val, body.type || 'fact', ts)
    .run();

  const embedding = await c.env.AI.run(
    '@cf/baai/bge-base-en-v1.5',
    { text: [body.val] },
  );

  await c.env.VECTORIZE.upsert([
    {
      id: body.key,
      values: embedding.data[0],
      metadata: { text: body.val },
    },
  ]);

  return c.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────────────────────
   FILES
───────────────────────────────────────────────────────────────────────────── */
app.put('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.arrayBuffer();

  await c.env.FILES.put(key, body);

  const fi = new FileIntelligence(c.env);
  await fi.processFile(key, body);

  return c.json({ ok: true, key });
});

/* ─────────────────────────────────────────────────────────────────────────────
   SESSION PROXY
───────────────────────────────────────────────────────────────────────────── */
app.all('/session/:id/*', async (c) => {
  const id = c.env.SESSION.idFromName(c.req.param('id'));
  return c.env.SESSION.get(id).fetch(c.req.raw);
});

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORTS
───────────────────────────────────────────────────────────────────────────── */
export default {
  fetch: app.fetch,

  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      env.AUTOMATION_WORKFLOW.create({
        params: { trigger: 'cron', cron: event.cron },
      }),
    );
  },

  async queue(batch: MessageBatch<any>, env: Bindings) {
    for (const msg of batch.messages) {
      console.log('[Queue]', msg.body);
      msg.ack();
    }
  },
};
