// src/index.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { memory } from './api/memory'
import { SuperAgent } from './agent/engine'
import { AgentDO, SessionDO } from './durable-objects'
import { AutomationWorkflow } from './workflow'

export type Bindings = {
  DB: D1Database
  FILES: R2Bucket
  CACHE: KVNamespace
  AI: any
  VECTORIZE: VectorizeIndex
  SESSION: DurableObjectNamespace
  AGENT: DurableObjectNamespace
  AUTOMATION_WORKFLOW: Workflow
  ENVIRONMENT: 'development' | 'production'
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

/* ─────────────── Memory API ─────────────── */
app.route('/api/memory', memory)

/* ─────────────── Chat API ─────────────── */
app.post('/api/chat', async (c) => {
  const { messages } = await c.req.json()
  const text = messages?.[messages.length - 1]?.content ?? ''

  const agent = new SuperAgent(c.env)
  const result = await agent.run({
    userId: 'default',
    sessionId: 'default',
    query: text,
  })

  return c.json({
    messages: [
      { role: 'assistant', content: result },
    ],
  })
})

/* ─────────────── Durable Objects ─────────────── */
export { SessionDO, AgentDO }

/* ─────────────── Workflow ─────────────── */
export { AutomationWorkflow }

/* ─────────────── ✅ REQUIRED DEFAULT EXPORT ─────────────── */
export default {
  fetch: app.fetch,
}