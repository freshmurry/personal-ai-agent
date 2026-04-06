// src/api/memory.ts
import { Hono } from 'hono'

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


export const memory = new Hono<{ Bindings: Bindings }>()

/* ─────────────── GET all memory ─────────────── */
memory.get('/', async (c) => {
  const stmt = c.env.DB.prepare('SELECT * FROM memory')
  const { results } = await stmt.bind().all()
  return c.json(results ?? [])
})

/* ─────────────── POST add / update memory ─────────────── */
memory.post('/', async (c) => {
  const { key, val, type = 'fact' } = await c.req.json()

  if (!key || !val) {
    return c.json({ error: 'Missing key or value' }, 400)
  }

  await c.env.DB.prepare(`
    INSERT INTO memory (key, val, type, freq, ts)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      val = excluded.val,
      type = excluded.type,
      freq = freq + 1,
      ts = excluded.ts
  `)
    .bind(key, val, type, Date.now())
    .run()

  return c.json({ ok: true })
})

/* ─────────────── DELETE all memory ─────────────── */
memory.delete('/', async (c) => {
  await c.env.DB
    .prepare('DELETE FROM memory')
    .bind()
    .run()

  return c.json({ ok: true })
})

/* ─────────────── DELETE specific key ─────────────── */
memory.delete('/:key', async (c) => {
  const key = c.req.param('key')

  await c.env.DB
    .prepare('DELETE FROM memory WHERE key = ?')
    .bind(key)
    .run()

  return c.json({ ok: true })
})