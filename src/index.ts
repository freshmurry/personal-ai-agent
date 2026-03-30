import { Hono } from 'hono';
import { cors } from 'hono/cors';

/**
 * SuperAgent — Integrated Worker Controller
 * Source of Truth: D1 Database
 * Storage: R2 Bucket
 * Logic: Cloudflare Workflows
 */

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

// 1. GLOBAL MIDDLEWARE: CORS & RATE LIMITING
app.use('*', cors());

app.use('/api/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || 'anon';
  const limitKey = `rate:${ip}`;
  
  const current = await c.env.CACHE.get(limitKey);
  const count = parseInt(current || '0');

  // Rate limit: 100 requests per minute per IP
  if (count > 100) {
    return c.json({ error: 'Rate limit exceeded. Please wait a minute.' }, 429);
  }

  await c.env.CACHE.put(limitKey, (count + 1).toString(), { expirationTtl: 60 });
  await next();
});

// 2. SERVE UI (Cloudflare Assets)
app.get('/', async (c) => c.env.ASSETS.fetch(c.req.raw));

// 3. IDENTITY & MEMORY API (D1)
app.get('/api/identity', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM memory WHERE type = 'identity' ORDER BY ts DESC"
  ).all();
  return c.json(results);
});

app.post('/api/memory', async (c) => {
  const { key, val, type } = await c.req.json();
  const ts = Date.now();
  // Standard D1 UPSERT for the memory table
  await c.env.DB.prepare(`
    INSERT INTO memory (key, val, type, ts) 
    VALUES (?, ?, ?, ?) 
    ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts
  `).bind(key, val, type || 'fact', ts).run();
  return c.json({ success: true });
});

// 4. HISTORY API (D1)
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM conversations ORDER BY ts DESC LIMIT 100"
  ).all();
  return c.json(results);
});

// 5. FILES API (R2 Storage + D1 Metadata Sync)
app.put('/api/files/:name', async (c) => {
  const name = c.req.param('name');
  const blob = await c.req.blob();
  const ext = name.split('.').pop() || '';
  
  // A. Save binary to R2
  await c.env.FILES.put(name, blob);
  
  // B. Sync metadata to D1 so the UI/Agent can see it
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

// 6. OAUTH CALLBACK (KV State Check + D1 Persistence)
app.get('/auth/callback/:service', async (c) => {
  const service = c.req.param('service');
  const { code, state } = c.req.query();

  const storedState = await c.env.OAUTH_STATES.get(`state:${service}`);
  if (!state || state !== storedState) return c.text('OAuth CSRF Warning: State mismatch', 403);

  // Note: Here you would normally fetch the real token from the provider
  const mockAccessToken = `tok_${crypto.randomUUID()}`;
  
  await c.env.DB.prepare(`
    INSERT INTO oauth_tokens (service, access_token, created) 
    VALUES (?, ?, ?)
    ON CONFLICT(service) DO UPDATE SET access_token=excluded.access_token, created=excluded.created
  `).bind(service, mockAccessToken, Date.now()).run();

  return c.redirect('/?auth=success');
});

// 7. WHATSAPP WEBHOOK (Twilio)
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.parseBody();
  const from = body.From as string;
  const text = body.Body as string;

  // Trigger Automation Workflow (mapped to src/workflows.ts)
  await c.env.AUTOMATION_WORKFLOW.create({
    params: { 
      trigger: 'whatsapp', 
      payload: { sender: from, message: text },
      instructions: "Process this incoming WhatsApp message and respond if necessary."
    }
  });

  return c.text('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
    'Content-Type': 'text/xml',
  });
});

// 8. EXPORT FOR CRON + QUEUE
export default {
  fetch: app.fetch,

  // Cron Handler: Checks D1 for active automations matching the cron pattern
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

  // Queue Handler: For high-volume async tasks
  async queue(batch: MessageBatch<any>, env: Bindings) {
    for (const message of batch.messages) {
      console.log('Ingesting queue task:', message.body);
      // Example: Log queue activity to history
      await env.DB.prepare("INSERT INTO conversations (role, content, ts) VALUES (?, ?, ?)")
        .bind('system', `Queue processing: ${JSON.stringify(message.body)}`, Date.now())
        .run();
    }
  }
};
