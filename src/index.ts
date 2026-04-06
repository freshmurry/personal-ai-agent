// src/index.ts — SuperAgent main entry point
// Base44-style SuperAgent on Cloudflare Workers
// Routes: REST API + Durable Object agent routing

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { routeAgentRequest } from 'agents'
import type { Bindings } from './bindings'
import { SuperAgent } from './agent/engine'
import { AutomationWorkflow } from './workflow'
import { MemoryManager } from './agent/memory-manager'
import { FileIntelligence } from './agent/file-intelligence'
import { Planner } from './agent/planner'

export { SuperAgent, AutomationWorkflow }

const app = new Hono<{ Bindings: Bindings }>({ strict: false })

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-File-Name', 'X-File-Size'],
}))

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/identity', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT val FROM memory WHERE key = '__identity__'`
  ).first<{ val: string }>()
  if (row?.val) {
    try { return c.json(JSON.parse(row.val)) } catch {}
  }
  return c.json({
    agentName: 'Agent Apex',
    userName: 'Lawrence',
    soul: '',
    description: 'A Base44-style SuperAgent — goal-driven, tool-using, self-improving.',
  })
})

app.put('/api/identity', async (c) => {
  const body = await c.req.json()
  await c.env.DB.prepare(
    `INSERT INTO memory (key, val, type, freq, ts, last_access)
     VALUES ('__identity__', ?, 'system', 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts`
  ).bind(JSON.stringify(body), Date.now(), Date.now()).run()
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// CHAT API — direct REST (used by standalone pages, not the /agents/ route)
// For full agentic tool use, the frontend should connect to /agents/SuperAgent/:id
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (c) => {
  const body = await c.req.json<{
    messages: Array<{ role: string; content: string }>
    system?: string
    stream?: boolean
    max_tokens?: number
    model?: string
  }>()

  const messages = body.messages ?? []
  const maxTokens = body.max_tokens ?? 2048
  const useStream = body.stream ?? false

  // Load identity for system prompt
  let systemPrompt = body.system
  if (!systemPrompt) {
    const idRow = await c.env.DB.prepare(`SELECT val FROM memory WHERE key='__identity__'`).first<{val:string}>()
    try { const id = idRow ? JSON.parse(idRow.val) : null; systemPrompt = id?.soul || '' } catch {}
  }
  if (!systemPrompt) {
    systemPrompt = "You are Agent Apex — Lawrence Murry's personal AI Chief of Staff. You are sharp, warm, direct, and take decisive action. Deep knowledge of proposal management, government contracting, SaaS, AI, and all of Lawrence's projects. Never be evasive — always give concrete, actionable answers."
  }

  // Also prime with memory context
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
  if (lastUserMsg) {
    try {
      const mm = new MemoryManager(c.env)
      const ctx = await mm.retrieve(lastUserMsg, 5)
      if (ctx.summary) systemPrompt += `\n\n${ctx.summary}`
    } catch {}
  }

  const cfMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
  ]

  if (useStream) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const enc = new TextEncoder()
    const writeSSE = async (obj: Record<string, unknown>) => {
      await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
    }

    c.executionCtx.waitUntil((async () => {
      try {
        let success = false

        // Try CF Workers AI
        try {
          const cfResult = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
            messages: cfMessages, stream: true,
          } as any) as ReadableStream

          if (cfResult instanceof ReadableStream) {
            success = true
            const reader = cfResult.getReader(); const dec = new TextDecoder(); let buf = ''
            while (true) {
              const { value, done } = await reader.read(); if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() ?? ''
              for (const line of lines) {
                const t = line.trim(); if (!t.startsWith('data: ')) continue
                const raw = t.slice(6); if (raw === '[DONE]') continue
                try {
                  const ev = JSON.parse(raw)
                  const text = ev?.response ?? ev?.choices?.[0]?.delta?.content ?? ''
                  if (text) await writeSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
                } catch {}
              }
            }
          }
        } catch (e) { console.error('[chat/stream] CF AI error:', e) }

        // Fallback: Anthropic
        if (!success && c.env.ANTHROPIC_API_KEY) {
          const antRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': c.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system: systemPrompt, messages: messages.map(m => ({ role: m.role, content: m.content })), stream: true }),
          })
          if (antRes.ok && antRes.body) {
            const reader = antRes.body.getReader(); const dec = new TextDecoder(); let buf = ''
            while (true) {
              const { value, done } = await reader.read(); if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() ?? ''
              for (const line of lines) {
                if (line.trim().startsWith('data: ')) await writer.write(enc.encode(line.trim() + '\n\n'))
              }
            }
          }
        }

        await writeSSE({ type: 'message_stop' })
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } catch (e) {
        await writeSSE({ type: 'error', error: String(e) })
      } finally {
        writer.close()
      }
    })())

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    })

  } else {
    try {
      const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, { messages: cfMessages } as any) as { response?: string }
      return c.json({ content: [{ type: 'text', text: result?.response ?? '' }], model: 'cloudflare/llama-3.3-70b' })
    } catch {
      if (c.env.ANTHROPIC_API_KEY) {
        const antRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': c.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system: systemPrompt, messages: messages.map(m => ({ role: m.role, content: m.content })) }),
        })
        return c.json(await antRes.json())
      }
      return c.json({ error: { message: 'No AI model available' } }, 503)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT role, content, ts FROM conversations ORDER BY ts ASC LIMIT 200`
  ).all()
  return c.json({ messages: results ?? [] })
})

app.post('/api/history', async (c) => {
  const { messages } = await c.req.json<{ messages: Array<{ role: string; content: string; ts?: number }> }>()
  if (!Array.isArray(messages)) return c.json({ ok: false })
  for (const msg of messages.slice(-100)) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO conversations (role, content, ts) VALUES (?, ?, ?)`
    ).bind(msg.role, String(msg.content).slice(0, 8000), msg.ts || Date.now()).run()
  }
  return c.json({ ok: true })
})

app.delete('/api/history', async (c) => {
  await c.env.DB.prepare(`DELETE FROM conversations`).run()
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/memory', async (c) => {
  const mm = new MemoryManager(c.env)
  const memories = await mm.getAll(100)
  return c.json({ memories })
})

app.post('/api/memory', async (c) => {
  const { key, value, type } = await c.req.json<{ key: string; value: string; type?: string }>()
  if (!key || !value) return c.json({ error: 'key and value required' }, 400)
  const mm = new MemoryManager(c.env)
  const result = await mm.store(key, value, (type as any) || 'fact')
  return c.json(result)
})

app.delete('/api/memory/:key', async (c) => {
  const mm = new MemoryManager(c.env)
  await mm.delete(c.req.param('key'))
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// FILES API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/files', async (c) => {
  try {
    const listed = await c.env.FILES.list({ limit: 500 })
    const files = listed.objects.map(o => ({
      key: o.key,
      name: (o.key.split('/').pop() || o.key),
      size: o.size,
      uploaded: o.uploaded?.toISOString(),
      etag: o.etag,
    }))
    return c.json({ files })
  } catch(e) {
    return c.json({ files: [], error: String(e) })
  }
})

app.get('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const obj = await c.env.FILES.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  return new Response(obj.body, { headers })
})

app.put('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const body = await c.req.arrayBuffer()
  const ct = c.req.header('content-type') || 'application/octet-stream'
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: ct } })
  return c.json({ ok: true, key })
})

app.delete('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key')
  await c.env.FILES.delete(key)
  // Also remove from Vectorize
  try {
    const listed = await c.env.VECTORIZE.deleteByIds([key])
    console.log('[files/delete] Vectorize delete:', listed)
  } catch {}
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// FILE INDEXING API
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/index', async (c) => {
  const { key } = await c.req.json<{ key: string }>()
  if (!key) return c.json({ error: 'key required' }, 400)
  try {
    const obj = await c.env.FILES.get(key)
    if (!obj) return c.json({ error: `File "${key}" not found in R2` }, 404)
    const buffer = await obj.arrayBuffer()
    const fi = new FileIntelligence(c.env)
    const result = await fi.processFile(key, buffer)
    return c.json(result)
  } catch(e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GOALS API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/goals', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM goals ORDER BY priority DESC, created DESC`
  ).all()
  return c.json({ goals: results })
})

app.post('/api/goals', async (c) => {
  const body = await c.req.json<{ description: string; priority?: number }>()
  if (!body.description) return c.json({ error: 'description required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO goals (id, description, status, priority, created, last_updated) VALUES (?, ?, 'active', ?, ?, ?)`
  ).bind(id, body.description, body.priority ?? 5, Date.now(), Date.now()).run()
  return c.json({ ok: true, id })
})

app.patch('/api/goals/:id', async (c) => {
  const body = await c.req.json<{ status?: string; priority?: number; progress?: string }>()
  const sets: string[] = []
  const vals: unknown[] = []
  if (body.status)   { sets.push('status = ?');   vals.push(body.status) }
  if (body.priority) { sets.push('priority = ?'); vals.push(body.priority) }
  if (body.progress) { sets.push('progress = ?'); vals.push(body.progress) }
  if (!sets.length) return c.json({ ok: true })
  sets.push('last_updated = ?'); vals.push(Date.now()); vals.push(c.req.param('id'))
  await c.env.DB.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()
  return c.json({ ok: true })
})

app.delete('/api/goals/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM goals WHERE id = ?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// PLANS API (structured reasoning audit trail)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/plans', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, goal, status, current_step, created, completed, reflection FROM plans ORDER BY created DESC LIMIT 50`
  ).all()
  return c.json({ plans: results })
})

app.get('/api/plans/:id', async (c) => {
  const plan = await c.env.DB.prepare(`SELECT * FROM plans WHERE id = ?`).bind(c.req.param('id')).first()
  if (!plan) return c.notFound()
  return c.json(plan)
})

// ─────────────────────────────────────────────────────────────────────────────
// TOOL LOG API (audit trail)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/tool-log', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const { results } = await c.env.DB.prepare(
    `SELECT id, plan_id, tool_name, status, duration_ms, error, ts FROM tool_log ORDER BY ts DESC LIMIT ?`
  ).bind(Math.min(limit, 200)).all()
  return c.json({ logs: results })
})

// ─────────────────────────────────────────────────────────────────────────────
// AGENT EVENTS API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/events', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, type, payload, ts FROM agent_events ORDER BY ts DESC LIMIT 100`
  ).all()
  return c.json({ events: results })
})

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATIONS API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/automations', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM automations ORDER BY created DESC`).all()
  return c.json({ automations: results })
})

app.post('/api/automations', async (c) => {
  const body = await c.req.json<{ name: string; instructions: string; cron: string; notify?: string }>()
  if (!body.name || !body.instructions) return c.json({ error: 'name and instructions required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO automations (id, name, instructions, cron, notify, active, runs, successes, failures, created) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, ?)`
  ).bind(id, body.name, body.instructions, body.cron || '0 9 * * *', body.notify || 'chat', Date.now()).run()
  return c.json({ ok: true, id })
})

app.patch('/api/automations/:id', async (c) => {
  const body = await c.req.json<{ active?: boolean; name?: string; instructions?: string; cron?: string }>()
  if (typeof body.active === 'boolean') {
    await c.env.DB.prepare(`UPDATE automations SET active = ? WHERE id = ?`).bind(body.active ? 1 : 0, c.req.param('id')).run()
  }
  if (body.name) await c.env.DB.prepare(`UPDATE automations SET name = ? WHERE id = ?`).bind(body.name, c.req.param('id')).run()
  if (body.instructions) await c.env.DB.prepare(`UPDATE automations SET instructions = ? WHERE id = ?`).bind(body.instructions, c.req.param('id')).run()
  if (body.cron) await c.env.DB.prepare(`UPDATE automations SET cron = ? WHERE id = ?`).bind(body.cron, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.delete('/api/automations/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM automations WHERE id = ?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// APPROVALS API (human-in-the-loop)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/approvals', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM approvals ORDER BY created DESC LIMIT 100`
  ).all()
  return c.json({ approvals: results })
})

app.patch('/api/approvals/:id', async (c) => {
  const { status } = await c.req.json<{ status: string }>()
  if (!['approved', 'rejected'].includes(status)) return c.json({ error: 'Invalid status' }, 400)
  await c.env.DB.prepare(`UPDATE approvals SET status = ? WHERE id = ?`).bind(status, c.req.param('id')).run()

  // If approved linkedin_post — execute it
  if (status === 'approved') {
    const approval = await c.env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(c.req.param('id')).first<{action_type: string; payload: string}>()
    if (approval?.action_type === 'linkedin_post') {
      // Queue actual post via automation workflow
      await c.env.DB.prepare(
        `INSERT INTO automations (id, name, instructions, cron, notify, active, runs, created) VALUES (?, 'Approved: LinkedIn Post', ?, 'once', 'chat', 0, 0, ?)`
      ).bind(crypto.randomUUID(), `Post to LinkedIn: ${JSON.parse(approval.payload).content}`, Date.now()).run()
    }
  }

  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTORS / OAUTH API
// ─────────────────────────────────────────────────────────────────────────────
const OAUTH_PROVIDERS: Record<string, {
  name: string; authUrl: string; tokenUrl: string;
  scopes: string[]; clientIdKey: string; clientSecretKey: string
}> = {
  google: {
    name: 'Google', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
    clientIdKey: 'GOOGLE_CLIENT_ID', clientSecretKey: 'GOOGLE_CLIENT_SECRET',
  },
  github: {
    name: 'GitHub', authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'workflow'],
    clientIdKey: 'GITHUB_CLIENT_ID', clientSecretKey: 'GITHUB_CLIENT_SECRET',
  },
  linkedin: {
    name: 'LinkedIn', authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['r_liteprofile', 'w_member_social'],
    clientIdKey: 'LINKEDIN_CLIENT_ID', clientSecretKey: 'LINKEDIN_CLIENT_SECRET',
  },
}

app.get('/api/connectors', async (c) => {
  const statuses: Record<string, { connected: boolean; name: string; scopes?: string[] }> = {}
  for (const [key, prov] of Object.entries(OAUTH_PROVIDERS)) {
    const token = await c.env.DB.prepare(
      `SELECT access_token FROM oauth_tokens WHERE service = ? AND expires_at > ?`
    ).bind(key, Date.now()).first<{ access_token: string }>()
    statuses[key] = { connected: !!token, name: prov.name, scopes: prov.scopes }
  }
  statuses['anthropic'] = { connected: !!(c.env as any).ANTHROPIC_API_KEY, name: 'Anthropic Claude' }
  return c.json(statuses)
})

app.get('/api/connectors/:service/auth', async (c) => {
  const service = c.req.param('service')
  const prov = OAUTH_PROVIDERS[service]
  if (!prov) return c.json({ error: 'Unknown service' }, 400)
  const clientId = (c.env as any)[prov.clientIdKey]
  if (!clientId) return c.html(`<h2>Missing ${prov.clientIdKey}</h2><p>Set this secret in your Cloudflare Worker: <code>wrangler secret put ${prov.clientIdKey}</code></p>`)
  const state = crypto.randomUUID()
  await (c.env.OAUTH_STATES as KVNamespace).put(state, service, { expirationTtl: 600 })
  const workerUrl = c.env.WORKER_URL || `https://${c.req.header('host')}`
  const redirectUri = `${workerUrl}/api/connectors/${service}/callback`
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: prov.scopes.join(' '), state, access_type: 'offline', prompt: 'consent' })
  return c.redirect(`${prov.authUrl}?${params}`)
})

app.get('/api/connectors/:service/callback', async (c) => {
  const service = c.req.param('service')
  const { code, state, error } = c.req.query()
  if (error) return c.html(`<h2>OAuth Error</h2><p>${error}</p>`)
  const stored = await (c.env.OAUTH_STATES as KVNamespace).get(state as string)
  if (stored !== service) return c.html('<h2>Invalid state — CSRF check failed</h2>')
  const prov = OAUTH_PROVIDERS[service]
  if (!prov) return c.html('<h2>Unknown provider</h2>')
  const clientId = (c.env as any)[prov.clientIdKey]
  const clientSecret = (c.env as any)[prov.clientSecretKey]
  const workerUrl = c.env.WORKER_URL || `https://${c.req.header('host')}`
  const redirectUri = `${workerUrl}/api/connectors/${service}/callback`
  const tokenRes = await fetch(prov.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const td = await tokenRes.json() as any
  if (td.error || !td.access_token) return c.html(`<h2>Token Error</h2><pre>${JSON.stringify(td)}</pre>`)
  const expiresAt = td.expires_in ? Date.now() + td.expires_in * 1000 : Date.now() + 3600000
  await c.env.DB.prepare(
    `INSERT INTO oauth_tokens (service, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at`
  ).bind(service, td.access_token, td.refresh_token ?? '', expiresAt, Date.now()).run()
  return c.html(`<html><head><title>Connected!</title></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ ${prov.name} Connected</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`)
})

app.delete('/api/connectors/:service', async (c) => {
  await c.env.DB.prepare(`DELETE FROM oauth_tokens WHERE service = ?`).bind(c.req.param('service')).run()
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// SELF-AUDIT / PERFORMANCE API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/performance', async (c) => {
  const planner = new Planner(c.env)
  const mm = new MemoryManager(c.env)
  const [stats, memAudit] = await Promise.all([
    planner.getPerformanceStats(),
    mm.selfAudit(),
  ])

  const { results: recentEvents } = await c.env.DB.prepare(
    `SELECT type, COUNT(*) as cnt FROM agent_events GROUP BY type ORDER BY cnt DESC LIMIT 10`
  ).all<{ type: string; cnt: number }>()

  return c.json({ plan_stats: stats, memory_audit: memAudit, event_summary: recentEvents })
})

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({
  ok: true,
  version: '6.0.0',
  ts: Date.now(),
  anthropic: !!(c.env as any).ANTHROPIC_API_KEY,
  github: !!(c.env as any).GITHUB_ACCESS_TOKEN,
  environment: c.env.ENVIRONMENT || 'unknown',
}))

// ─────────────────────────────────────────────────────────────────────────────
// WORKER ENTRY
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Route /agents/* to Durable Object SuperAgent
    if (url.pathname.startsWith('/agents/')) {
      return (await routeAgentRequest(request, env)) ?? new Response('Agent not found', { status: 404 })
    }

    return app.fetch(request, env, ctx)
  },
}
