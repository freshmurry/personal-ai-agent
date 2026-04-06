// src/index.ts — SuperAgent main entry point
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { routeAgentRequest } from 'agents'

import type { Bindings } from './bindings'
import { memory } from './api/memory'
import { SuperAgent } from './agent/engine'
import { AutomationWorkflow } from './workflow'

const app = new Hono<{ Bindings: Bindings }>({ strict: false })

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }))

// ── Memory API ────────────────────────────────────────────────────────────────
app.route('/api/memory', memory)

// ── Identity API ──────────────────────────────────────────────────────────────
app.get('/api/identity', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT val FROM memory WHERE key = '__identity__'`
  ).first<{ val: string }>()
  if (row?.val) {
    try { return c.json(JSON.parse(row.val)) } catch {}
  }
  return c.json({ agentName: 'SuperAgent', userName: 'Lawrence', soul: "You are Agent Apex — Lawrence Murry's personal AI Chief of Staff. You are sharp, warm, direct, and take action. You have 14+ years of proposal management knowledge. You handle everything: writing, coding, research, strategy, career, business.", description: 'A fully autonomous personal AI agent.' })
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

// ── Chat API — PRIMARY: Cloudflare Workers AI, FALLBACK: Anthropic ────────────
app.post('/api/chat', async (c) => {
  const body = await c.req.json<{
    messages: Array<{ role: string; content: string }>
    system?: string
    stream?: boolean
    model?: string
    max_tokens?: number
  }>()

  const messages = body.messages ?? []
  const systemPrompt = body.system ?? "You are Agent Apex — Lawrence Murry's personal AI Chief of Staff. You are sharp, warm, direct, and take decisive action. You have deep knowledge of proposal management, government contracting, SaaS, and AI. Never be evasive — always give concrete, actionable answers."
  const maxTokens = body.max_tokens ?? 2048
  const useStream = body.stream ?? false

  // Build CF Workers AI messages
  const cfMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }))
  ]

  if (useStream) {
    // ── STREAMING ────────────────────────────────────────────────────────────
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const enc = new TextEncoder()

    const writeSSE = async (obj: Record<string, unknown>) => {
      await writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
    }

    c.executionCtx.waitUntil((async () => {
      try {
        // Try Cloudflare Workers AI first
        let cfSuccess = false
        try {
          const cfResult = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
            messages: cfMessages,
            stream: true,
          } as any) as ReadableStream

          if (cfResult && cfResult instanceof ReadableStream) {
            cfSuccess = true
            const reader = cfResult.getReader()
            const dec = new TextDecoder()
            let buf = ''

            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n')
              buf = lines.pop() ?? ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data: ')) continue
                const raw = trimmed.slice(6)
                if (raw === '[DONE]') continue
                try {
                  const ev = JSON.parse(raw)
                  const text = ev?.response ?? ev?.choices?.[0]?.delta?.content ?? ''
                  if (text) {
                    // Emit in Anthropic SSE format so frontend parser works
                    await writeSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
                  }
                } catch { /* skip malformed */ }
              }
            }
          }
        } catch (cfErr) {
          console.error('[chat] CF AI stream failed:', cfErr)
        }

        // Fallback: Anthropic
        if (!cfSuccess && c.env.ANTHROPIC_API_KEY) {
          const antRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': c.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: maxTokens,
              system: systemPrompt,
              messages: messages.map(m => ({ role: m.role, content: m.content })),
              stream: true,
            }),
          })

          if (antRes.ok && antRes.body) {
            const reader = antRes.body.getReader()
            const dec = new TextDecoder()
            let buf = ''
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n')
              buf = lines.pop() ?? ''
              for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed.startsWith('data: ')) {
                  // Pass Anthropic events through as-is — frontend already parses this format
                  await writer.write(enc.encode(trimmed + '\n\n'))
                }
              }
            }
          }
        }

        await writeSSE({ type: 'message_stop' })
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } catch (err) {
        console.error('[chat] Fatal stream error:', err)
        await writeSSE({ type: 'error', error: String(err) })
      } finally {
        writer.close()
      }
    })())

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })

  } else {
    // ── NON-STREAMING ─────────────────────────────────────────────────────────
    try {
      const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
        messages: cfMessages,
      } as any) as { response?: string }

      const text = result?.response ?? ''
      // Return in Anthropic format so frontend code works
      return c.json({
        content: [{ type: 'text', text }],
        model: 'cloudflare/llama-3.3-70b',
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    } catch (cfErr) {
      console.error('[chat] CF AI non-stream failed:', cfErr)

      // Fallback to Anthropic
      if (c.env.ANTHROPIC_API_KEY) {
        const antRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': c.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
          }),
        })
        const data = await antRes.json()
        return c.json(data)
      }

      return c.json({ error: { message: 'No AI model available' } }, 500)
    }
  }
})

// ── History API ───────────────────────────────────────────────────────────────
app.get('/api/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT role, content FROM conversations ORDER BY ts ASC LIMIT 200`
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

// ── Files API (R2) ────────────────────────────────────────────────────────────
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
  return c.json({ ok: true })
})

app.delete('/api/files/:key{.+}', async (c) => {
  const key = c.req.param('key')
  await c.env.FILES.delete(key)
  return c.json({ ok: true })
})

// ── Automations API ───────────────────────────────────────────────────────────
app.get('/api/automations', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM automations ORDER BY created DESC`
  ).all()
  return c.json({ automations: results })
})

app.post('/api/automations', async (c) => {
  const body = await c.req.json<{ name: string; instructions: string; cron: string; notify?: string }>()
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO automations (id, name, instructions, cron, notify, active, runs, successes, failures, created)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, ?)`
  ).bind(id, body.name, body.instructions, body.cron, body.notify || 'chat', Date.now()).run()
  return c.json({ ok: true, id })
})

app.delete('/api/automations/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM automations WHERE id = ?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.patch('/api/automations/:id/toggle', async (c) => {
  await c.env.DB.prepare(
    `UPDATE automations SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id = ?`
  ).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── Goals API ─────────────────────────────────────────────────────────────────
app.get('/api/goals', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM goals ORDER BY priority DESC, created DESC`
  ).all()
  return c.json({ goals: results })
})

app.post('/api/goals', async (c) => {
  const body = await c.req.json<{ description: string; priority?: number }>()
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO goals (id, description, status, priority, created, last_updated) VALUES (?, ?, 'active', ?, ?, ?)`
  ).bind(id, body.description, body.priority ?? 5, Date.now(), Date.now()).run()
  return c.json({ ok: true, id })
})

// ── Approvals API ─────────────────────────────────────────────────────────────
app.get('/api/approvals', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM approvals WHERE status = 'pending' ORDER BY created DESC`
  ).all()
  return c.json({ approvals: results })
})

app.post('/api/approvals/:id/approve', async (c) => {
  await c.env.DB.prepare(`UPDATE approvals SET status = 'approved' WHERE id = ?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/api/approvals/:id/reject', async (c) => {
  await c.env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── OAuth Connectors API ──────────────────────────────────────────────────────
const OAUTH_PROVIDERS: Record<string, { name: string; authUrl: string; tokenUrl: string; scopes: string[]; clientIdKey: string; clientSecretKey: string }> = {
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
    clientIdKey: 'GOOGLE_CLIENT_ID',
    clientSecretKey: 'GOOGLE_CLIENT_SECRET',
  },
  github: {
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'workflow'],
    clientIdKey: 'GITHUB_CLIENT_ID',
    clientSecretKey: 'GITHUB_CLIENT_SECRET',
  },
  linkedin: {
    name: 'LinkedIn',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['r_liteprofile', 'w_member_social'],
    clientIdKey: 'LINKEDIN_CLIENT_ID',
    clientSecretKey: 'LINKEDIN_CLIENT_SECRET',
  },
}

app.get('/api/connectors', async (c) => {
  const statuses: Record<string, { connected: boolean; name: string }> = {}
  for (const [key, provider] of Object.entries(OAUTH_PROVIDERS)) {
    const token = await c.env.DB.prepare(
      `SELECT access_token FROM oauth_tokens WHERE service = ? AND expires_at > ?`
    ).bind(key, Date.now()).first<{ access_token: string }>()
    statuses[key] = { connected: !!token, name: provider.name }
  }
  // Check raw token secrets (non-OAuth)
  statuses['anthropic'] = { connected: !!c.env.ANTHROPIC_API_KEY, name: 'Anthropic Claude' }
  return c.json(statuses)
})

app.get('/api/oauth/:provider/connect', async (c) => {
  const provider = c.req.param('provider')
  const prov = OAUTH_PROVIDERS[provider]
  if (!prov) return c.json({ error: 'Unknown provider' }, 400)

  const clientId = (c.env as any)[prov.clientIdKey]
  if (!clientId) return c.json({ error: `${prov.clientIdKey} not configured in secrets` }, 400)

  const state = crypto.randomUUID()
  await c.env.OAUTH_STATES.put(state, String(provider), { expirationTtl: 600 })

  const workerUrl = c.env.WORKER_URL || `https://${c.req.header('host')}`
  const redirectUri = `${workerUrl}/api/oauth/${provider}/callback`

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: prov.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  })

  return c.redirect(`${prov.authUrl}?${params}`)
})

app.get('/api/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider')
  const { code, state, error } = c.req.query()

  if (error) return c.html(`<h2>OAuth Error: ${error}</h2><p>Close this window and try again.</p>`)

  const storedProvider = await c.env.OAUTH_STATES.get(state)
  if (storedProvider !== provider) return c.html(`<h2>Invalid state</h2><p>CSRF check failed. Try again.</p>`)

  const prov = OAUTH_PROVIDERS[provider]
  if (!prov) return c.html(`<h2>Unknown provider</h2>`)

  const clientId = (c.env as any)[prov.clientIdKey]
  const clientSecret = (c.env as any)[prov.clientSecretKey]
  const workerUrl = c.env.WORKER_URL || `https://${c.req.header('host')}`
  const redirectUri = `${workerUrl}/api/oauth/${provider}/callback`

  const tokenRes = await fetch(prov.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })

  const tokenData = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }
  if (tokenData.error || !tokenData.access_token) {
    return c.html(`<h2>Token Error</h2><p>${JSON.stringify(tokenData)}</p>`)
  }

  const expiresAt = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : Date.now() + 3600000
  await c.env.DB.prepare(
    `INSERT INTO oauth_tokens (service, access_token, refresh_token, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at`
  ).bind(provider, tokenData.access_token, tokenData.refresh_token ?? '', expiresAt, Date.now()).run()

  return c.html(`
    <html><head><title>Connected!</title></head><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>✅ ${prov.name} Connected</h2>
    <p>You can close this window.</p>
    <script>setTimeout(() => window.close(), 2000)</script>
    </body></html>
  `)
})

app.delete('/api/oauth/:provider', async (c) => {
  await c.env.DB.prepare(`DELETE FROM oauth_tokens WHERE service = ?`).bind(c.req.param('provider')).run()
  return c.json({ ok: true })
})

// ── Agent tools proxy (for frontend MCP-style calls) ─────────────────────────
app.post('/api/tool/:name', async (c) => {
  const toolName = c.req.param('name')
  const input = await c.req.json()

  switch (toolName) {
    case 'web_search': {
      const { BrowserTool } = await import('./tools/browser')
      const bt = new BrowserTool(c.env)
      const results = await bt.searchWeb(input.query)
      return c.json({ results })
    }
    case 'browse_url': {
      const { BrowserTool } = await import('./tools/browser')
      const bt = new BrowserTool(c.env)
      const result = await bt.browseUrl(input.url, input.extract ?? 'text')
      return c.json(result)
    }
    case 'list_goals': {
      const { results } = await c.env.DB.prepare(`SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC`).all()
      return c.json({ goals: results })
    }
    case 'list_memory': {
      const { results } = await c.env.DB.prepare(`SELECT key, val, type FROM memory WHERE key NOT LIKE '___%' ORDER BY freq DESC LIMIT 50`).all()
      return c.json({ memories: results })
    }
    default:
      return c.json({ error: `Unknown tool: ${toolName}` }, 400)
  }
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ ok: true, version: '4.0.0', ts: Date.now() }))

// ── Export + Agent routing ────────────────────────────────────────────────────
export { SuperAgent, AutomationWorkflow }

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/agents/')) {
      return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 })
    }
    return app.fetch(request, env, ctx)
  },
}
