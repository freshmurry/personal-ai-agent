import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';

// Types for our Environment
type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  OAUTH_STATES: KVNamespace;
  AUTOMATION_WORKFLOW: Workflow;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
  ANTHROPIC_API_KEY: string;
  ASSETS: { fetch: typeof fetch };
};

const app = new Hono<{ Bindings: Bindings }>();

// 1. RATE LIMITING & CORS MIDDLEWARE
app.use('*', cors());
app.use('/api/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const { success } = await c.env.CACHE.get(`ratelimit:${ip}`).then(v => ({ success: !v }));
  if (!success) return c.text('Rate limit exceeded', 429);
  
  // Simple window-based limit (60s)
  await c.env.CACHE.put(`ratelimit:${ip}`, '1', { expirationTtl: 60 });
  await next();
});

// 2. SERVE UI (Cloudflare Pages/Assets Integration)
// If running as a Worker with Assets, we fallback to the asset provider
app.get('/', async (c) => c.env.ASSETS.fetch(c.req.raw));

// 3. IDENTITY & MEMORY API (D1 Implementation)
app.get('/api/identity', async (c) => {
  const identity = await c.env.DB.prepare("SELECT * FROM memory WHERE type = 'identity'").all();
  return c.json(identity.results);
});

app.post('/api/memory', async (c) => {
  const { key, val, type } = await c.req.json();
  const ts = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO memory (key, val, type, ts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts"
  ).bind(key, val, type || 'fact', ts).run();
  return c.json({ success: true });
});

// 4. HISTORY API (D1)
app.get('/api/history', async (c) => {
  const history = await c.env.DB.prepare("SELECT * FROM conversations ORDER BY ts DESC LIMIT 100").all();
  return c.json(history.results);
});

// 5. OAUTH CALLBACK HANDLER
app.get('/auth/callback/:service', async (c) => {
  const service = c.req.param('service');
  const code = c.req.query('code');
  const state = c.req.query('state');

  // Verify state from KV to prevent CSRF
  const storedState = await c.env.OAUTH_STATES.get(`state:${service}`);
  if (!state || state !== storedState) return c.text('Invalid state', 403);

  // Exchange code for token (Simplified example for GitHub)
  // In production, you'd fetch client_id/secret from c.env
  return c.json({ service, status: 'authenticated', note: 'Token stored in D1' });
});

// 6. WHATSAPP WEBHOOK (Twilio)
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.parseBody();
  const from = body.From as string;
  const text = body.Body as string;

  console.log(`WhatsApp from ${from}: ${text}`);

  // Trigger internal processing or Workflow
  await c.env.AUTOMATION_WORKFLOW.create({
    params: { source: 'whatsapp', payload: text, sender: from }
  });

  return c.text('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
    'Content-Type': 'text/xml',
  });
});

// 7. FILES API (R2)
app.put('/api/files/:name', async (c) => {
  const name = c.req.param('name');
  await c.env.FILES.put(name, c.req.raw.body);
  return c.json({ success: true, path: `/api/files/${name}` });
});

app.get('/api/files/:name', async (c) => {
  const file = await c.env.FILES.get(c.req.param('name'));
  if (!file) return c.notFound();
  return new Response(file.body);
});

// 8. CRON + QUEUE + WORKFLOW EXPORT
export default {
  fetch: app.fetch,

  // CRON TRIGGER
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    console.log(`Running scheduled task: ${event.cron}`);
    // Trigger a workflow instance for a "daily brief"
    await env.AUTOMATION_WORKFLOW.create({
      params: { type: 'daily_brief' }
    });
  },

  // QUEUE CONSUMER (if needed for high-volume ingestion)
  async queue(batch: MessageBatch<any>, env: Bindings) {
    for (const message of batch.messages) {
      console.log('Processing queue message:', message.body);
    }
  }
};
