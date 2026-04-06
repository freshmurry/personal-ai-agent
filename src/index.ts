// src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { Bindings } from './bindings'

import { memory } from './api/memory'
import { SuperAgent } from './agent/engine'
import { AgentDO, SessionDO } from './durable-objects'
import { AutomationWorkflow } from './workflow'

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

/* ─────────────── Memory API ─────────────── */
app.route('/api/memory', memory)

/* ─────────────── Chat API ─────────────── */
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const text = body?.messages?.at(-1)?.content ?? ''

  const agent = new SuperAgent(c.env)
  const reply = await agent.run(text)

  return c.json({
    messages: [{ role: 'assistant', content: reply }],
  })
})

/* ─────────────── Exports ─────────────── */
export { SessionDO, AgentDO }
export { AutomationWorkflow }

/* ✅ REQUIRED FOR MODULE WORKER */
export default {
  fetch: app.fetch,
}