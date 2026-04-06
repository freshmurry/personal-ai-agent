// src/api/memory.ts
import { Hono } from 'hono'
import type { Bindings } from '../bindings'

export const memory = new Hono<{ Bindings: Bindings }>()

memory.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT key, val, type, freq, ts FROM memory WHERE key != '__identity__' ORDER BY freq DESC, ts DESC LIMIT 100`
  ).all()
  return c.json({ memories: results })
})

memory.post('/', async (c) => {
  const { key, value, type } = await c.req.json<{ key: string; value: string; type?: string }>()
  const k = key.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)
  await c.env.DB.prepare(
    `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET val=excluded.val, type=excluded.type, freq=freq+1, ts=excluded.ts`
  ).bind(k, value.slice(0, 500), type ?? 'fact', Date.now(), Date.now()).run()
  return c.json({ ok: true, key: k })
})

memory.delete('/:key', async (c) => {
  await c.env.DB.prepare(`DELETE FROM memory WHERE key = ?`).bind(c.req.param('key')).run()
  return c.json({ ok: true })
})
