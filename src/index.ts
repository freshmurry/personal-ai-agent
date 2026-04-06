// src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { routeAgentRequest } from 'agents'
import type { Bindings } from './bindings'
import { memory } from './api/memory'
import { SuperAgent } from './agent/engine'
import { AutomationWorkflow } from './workflow'

const app = new Hono<{ Bindings: Bindings }>({ strict: false })
app.use('*', cors())

// Memory
app.route('/api/memory', memory)

// Identity
app.get('/api/identity', async (c) => {
  const row: any = await c.env.DB.prepare(`SELECT val FROM memory WHERE key = '__identity__'`).first()
  if (row?.val) { try { return c.json(JSON.parse(row.val)) } catch {} }
  return c.json({ agentName: 'SuperAgent', userName: '', soul: '', description: '' })
})
app.put('/api/identity', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare(
    `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES ('__identity__', ?, 'system', 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts`
  ).bind(JSON.stringify(body), Date.now(), Date.now()).run()
  return c.json({ ok: true })
})

// History
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT role, content FROM conversations ORDER BY ts ASC LIMIT 200`).all()
  return c.json({ messages: results ?? [] })
})
app.post('/api/history', async (c) => {
  const { messages } = await c.req.json()
  if (!Array.isArray(messages)) return c.json({ ok: false })
  for (const msg of messages.slice(-100)) {
    await c.env.DB.prepare(`INSERT OR IGNORE INTO conversations (role, content, ts) VALUES (?, ?, ?)`).bind(msg.role, msg.content, msg.ts || Date.now()).run()
  }
  return c.json({ ok: true })
})
app.delete('/api/history', async (c) => { await c.env.DB.prepare(`DELETE FROM conversations`).run(); return c.json({ ok: true }) })

// Files (R2)
app.get('/api/files/:key{.+}', async (c) => {
  const obj = await c.env.FILES.get(c.req.param('key'))
  if (!obj) return c.notFound()
  const headers = new Headers(); obj.writeHttpMetadata(headers)
  return new Response(obj.body, { headers })
})
app.put('/api/files/:key{.+}', async (c) => {
  const body = await c.req.arrayBuffer()
  await c.env.FILES.put(c.req.param('key'), body, { httpMetadata: { contentType: c.req.header('content-type') || 'application/octet-stream' } })
  return c.json({ ok: true })
})
app.delete('/api/files/:key{.+}', async (c) => { await c.env.FILES.delete(c.req.param('key')); return c.json({ ok: true }) })

// Automations
app.get('/api/automations', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM automations ORDER BY created DESC`).all()
  return c.json({ automations: results })
})
app.post('/api/automations', async (c) => {
  const body = await c.req.json()
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO automations (id, name, instructions, cron, notify, active, runs, successes, failures, created) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, ?)`
  ).bind(id, body.name, body.instructions, body.cron, body.notify || 'chat', Date.now()).run()
  return c.json({ ok: true, id })
})
app.delete('/api/automations/:id', async (c) => { await c.env.DB.prepare(`DELETE FROM automations WHERE id = ?`).bind(c.req.param('id')).run(); return c.json({ ok: true }) })
app.patch('/api/automations/:id/toggle', async (c) => {
  await c.env.DB.prepare(`UPDATE automations SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id = ?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// Approvals (human-in-the-loop)
app.get('/api/approvals', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created DESC`).all()
  return c.json({ approvals: results })
})
app.post('/api/approvals/:id/approve', async (c) => { await c.env.DB.prepare(`UPDATE approvals SET status = 'approved' WHERE id = ?`).bind(c.req.param('id')).run(); return c.json({ ok: true }) })
app.post('/api/approvals/:id/reject', async (c) => { await c.env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(c.req.param('id')).run(); return c.json({ ok: true }) })

// Goals
app.get('/api/goals', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM goals ORDER BY priority DESC, created DESC`).all()
  return c.json({ goals: results })
})

// Exports
export { SuperAgent, AutomationWorkflow }

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    // All /agents/* goes through Cloudflare Agents SDK (WebSocket + HTTP)
    if (url.pathname.startsWith('/agents/')) {
      return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 })
    }
    return app.fetch(request, env, ctx)
  },
}
