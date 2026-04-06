// src/tools/files.ts
import { Hono } from 'hono'

type Bindings = {
  FILES: R2Bucket
}

export const files = new Hono<{ Bindings: Bindings }>()

files.put('/:key', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.arrayBuffer()
  await c.env.FILES.put(key, body)
  return new Response('OK')
})

files.delete('/:key', async (c) => {
  const key = c.req.param('key')
  await c.env.FILES.delete(key)
  return new Response('OK')
})