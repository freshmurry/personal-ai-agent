// src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { Bindings } from './bindings'
import { memory } from './api/memory'
import { SuperAgent } from './agent/engine'
import { AgentDO, SessionDO } from './durable-objects'
import { AutomationWorkflow } from './workflow'

/**
 * IMPORTANT:
 * strict: false allows /api/foo and /api/foo/
 */
const app = new Hono<{ Bindings: Bindings }>({
  strict: false,
})

app.use('*', cors())

/* ───────── MEMORY ───────── */
app.route('/api/memory', memory)

/* ───────── IDENTITY ───────── */
app.get('/api/identity', () => {
  return Response.json({ id: 'default', name: 'User' })
})

/* ───────── HISTORY ───────── */
app.get('/api/history', async (c) => {
  const stmt = c.env.DB.prepare(
    'SELECT role, content FROM conversations ORDER BY ts ASC'
  )

  const { results } = await stmt.bind().all()
  return c.json({ messages: results ?? [] })
})

/* ───────── CHAT ───────── */
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const text = body?.messages?.at(-1)?.content ?? ''

  const agent = new SuperAgent(c.env)
  const reply = await agent.run(text)

  return c.json({
    messages: [{ role: 'assistant', content: reply }],
  })
})

/* ───────── EXPORTS ───────── */
export { SessionDO, AgentDO }
export { AutomationWorkflow }

/* ✅ REQUIRED FOR MODULE WORKER + DOs */
export default {
  fetch: app.fetch,
}