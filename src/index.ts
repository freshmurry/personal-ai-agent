import { Hono } from 'hono';
import { cors } from 'hono/cors';

/**
 * SuperAgent — Integrated Worker Controller
 * Source of Truth: D1 Database
 * Storage: R2 Bucket
 * Logic: Cloudflare Workflows, Durable Objects, Vectorize
 */

type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  OAUTH_STATES: KVNamespace;
  AUTOMATION_WORKFLOW: Workflow;
  VECTORIZE: VectorizeIndex;
  MY_QUEUE: Queue;
  AGENT: DurableObjectNamespace;
  SESSION: DurableObjectNamespace;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_NUMBER: string;
  ANTHROPIC_API_KEY: string;
  ASSETS: { fetch: typeof fetch };
  AI: any;
};

const app = new Hono<{ Bindings: Bindings }>();

// 1. GLOBAL MIDDLEWARE: CORS & RATE LIMITING
app.use('*', cors());

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
  return c.json(results);
});

app.post('/api/memory', async (c) => {
  const { key, val, type } = await c.req.json();
  const ts = Date.now();
  
  // A. SQL Persistence
  await c.env.DB.prepare(`
    INSERT INTO memory (key, val, type, ts) 
    VALUES (?, ?, ?, ?) 
    ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts
  `).bind(key, val, type || 'fact', ts).run();

  // B. Vector Embedding (Semantic Search)
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

// 5. FILES API (R2 Storage + D1 Metadata Sync)
app.put('/api/files/:name', async (c) => {
  const name = c.req.param('name');
  const blob = await c.req.blob();
  const ext = name.split('.').pop() || '';
  
  await c.env.FILES.put(name, blob);
  
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

// 6. DURABLE OBJECT PROXY (For real-time state)
app.all('/agent/:id/*', async (c) => {
  const id = c.env.AGENT.idFromName(c.req.param('id'));
  const obj = c.env.AGENT.get(id);
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

  // Offload to Queue for async processing to ensure 200 OK to Twilio under 1s
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

// 9. EXPORTS (Standard Fetch + Cron + Queue)
export default {
  fetch: app.fetch,

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
        // Trigger the workflow from the queue consumer
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
