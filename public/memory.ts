// public/memory.ts
import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

export const memory = new Hono<{ Bindings: Bindings }>()

memory.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM memory').all()
  return c.json(results)
})

memory.post('/', async (c) => {
  const { key, val, type = 'fact' } = await c.req.json()
  if (!key || !val) return c.json({ error: 'Missing key or value' }, 400)

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

memory.delete('/', async (c) => {
  await c.env.DB.prepare('DELETE FROM memory').run()
  return c.json({ ok: true })
})

memory.delete('/:key', async (c) => {
  const key = c.req.param('key')
  await c.env.DB.prepare('DELETE FROM memory WHERE key = ?').bind(key).run()
  return c.json({ ok: true })
})