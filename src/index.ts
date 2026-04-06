import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { SuperAgent } from './agent/engine'
import { FileIntelligence } from './agent/file-intelligence'

import { AgentDO, SessionDO } from './durable-objects'
export { AgentDO, SessionDO }

import { AutomationWorkflow } from './workflow'
export { AutomationWorkflow }

import { memory } from '../public/memory'

import type { ExecutionContext } from '@cloudflare/workers-types'

export type Bindings = {
  DB: D1Database
  FILES: R2Bucket
  CACHE: KVNamespace
  AI: any
  VECTORIZE: VectorizeIndex
  SESSION: DurableObjectNamespace
  AUTOMATION_WORKFLOW: Workflow
  ENVIRONMENT: 'development' | 'production'
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors({ origin: '*' }))

/* ─────────────── MEMORY ─────────────── */
app.route('/api/memory', memory)

/* ─────────────── CHAT ─────────────── */
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const userText = body.messages?.at(-1)?.content ?? ''
  const now = Date.now()

  const agent = new SuperAgent(c.env)
  const assistantText = await agent.run({
    userId: 'default',
    sessionId: 'default',
    query: userText,
  })

  await c.env.DB.prepare(
    `INSERT INTO conversations (role, content, ts)
     VALUES (?, ?, ?), (?, ?, ?)`
  )
    .bind('user', userText, now, 'assistant', assistantText, now + 1)
    .run()

  return c.json({
    messages: [
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    ],
  })
})

/* ─────────────── HISTORY ─────────────── */
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT role, content FROM conversations ORDER BY ts ASC`)
    .all()

  return c.json({ messages: results ?? [] })
})

app.post('/api/history', async () => Response.json({ ok: true }))

/* ─────────────── IDENTITY ─────────────── */
app.get('/api/identity', async () =>
  Response.json({ id: 'default', name: 'User' })
)

/* ─────────────── FILES ─────────────── */
app.put('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.arrayBuffer()

  await c.env.FILES.put(key, body)
  const fi = new FileIntelligence(c.env)
  await fi.processFile(key, body)

  return c.json({ ok: true })
})

/* ─────────────── MODULE EXPORTS ─────────────── */

// ✅ required for module workers + Durable Objects
export default {
  fetch: app.fetch,
}

// ✅ scheduled handler
export const scheduled = async (
  _event: any,
  env: Bindings,
  ctx: ExecutionContext,
) => {
  ctx.waitUntil(
    env.AUTOMATION_WORKFLOW.create({
      params: { trigger: 'heartbeat' },
    }),
  )
}

// ✅ EXACTLY ONE queue handler (REQUIRED)
export const queue = async (batch: {
  messages: {
    body: unknown
    ack(): void
  }[]
}) => {
  for (const msg of batch.messages) {
    msg.ack()
  }
}