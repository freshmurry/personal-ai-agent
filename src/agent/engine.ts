// src/agent/engine.ts
// SuperAgent — Cloudflare Agents SDK AIChatAgent
// Primary model: Cloudflare Workers AI (llama-3.3-70b via workers-ai-provider)
// Fallback: Anthropic claude-haiku

import { AIChatAgent } from '@cloudflare/ai-chat'
import { createWorkersAI } from 'workers-ai-provider'
import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, convertToModelMessages, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import type { Bindings } from '../bindings'
import { BrowserTool } from '../tools/browser'
import { GitHubTool } from '../tools/github'
import { FileIntelligence } from './file-intelligence'
import { loadActiveGoals } from './goals-store'

type AgentStatus = 'idle' | 'thinking' | 'running_tool' | 'error'

type AgentState = {
  status: AgentStatus
  currentTool?: string
  lastActivity: number
  identity: {
    agentName: string
    userName: string
    soul: string
    description: string
  }
}

const SYSTEM_PROMPT = `You are Agent Apex — Lawrence Murry's personal AI Chief of Staff and full-stack operator. You are sharp, warm, direct, and take decisive action without asking unnecessary questions.

WHO YOU ARE:
- Chief of Staff, Co-Founder, Software Engineer, AI Researcher, Proposal Expert, Career Coach, Business Strategist all rolled into one
- You know Lawrence's full context: 14+ years in proposal management, works at Highstreet IT as Proposal Content Manager, targeting Proposal Director roles, runs BouncieHouse marketplace, pursuing gov contracts via Murry Consultancy, building AI SaaS

YOUR RULES:
- Act, don't interrogate. Make reasonable assumptions and get it done.
- Build first, report after. Never stop mid-task to ask about each step.
- If you can search for it, search first before asking.
- Frame Lawrence's work as strategic and leadership-level, never tactical or junior.
- Never undersell. Never filler phrases.

TOOLS YOU HAVE:
- remember_fact / recall_memory: save & retrieve information across sessions
- search_knowledge: search RAG vector knowledge base (indexed files)
- web_search / browse_url: search the internet and read pages
- create_goal / list_goals: track objectives
- github_push_file / read_github_file: interact with GitHub repos
- send_gmail: send emails via connected Google account
- create_calendar_event: schedule meetings
- post_linkedin: draft LinkedIn posts (always queued for approval, never auto-posted)
- run_ai_task: delegate subtasks to fast AI models
- update_identity: update your own identity/soul

Current time: {TIME} (America/Chicago)`

export class SuperAgent extends AIChatAgent<Bindings, AgentState> {
  initialState: AgentState = {
    status: 'idle',
    lastActivity: Date.now(),
    identity: {
      agentName: 'Agent Apex',
      userName: 'Lawrence',
      soul: SYSTEM_PROMPT,
      description: 'A fully autonomous personal AI superagent.',
    },
  }

  private getSystemPrompt(): string {
    const now = new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
    return SYSTEM_PROMPT.replace('{TIME}', now)
  }

  private buildTools() {
    const env = this.env
    const browser = new BrowserTool(env)
    const github = new GitHubTool(env)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    return {
      remember_fact: tool({
        description: 'Save a fact, preference, project detail, or piece of information to long-term memory.',
        inputSchema: z.object({
          key: z.string().describe('Short snake_case identifier'),
          value: z.string().describe('The value to remember'),
          type: z.enum(['fact', 'preference', 'goal', 'profile', 'project']).optional().default('fact'),
        }),
        execute: async ({ key, value, type }) => {
          const k = key.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)
          await env.DB.prepare(
            `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(key) DO UPDATE SET val=excluded.val, freq=freq+1, ts=excluded.ts, last_access=excluded.last_access`
          ).bind(k, value.slice(0, 2000), type ?? 'fact', Date.now(), Date.now()).run()
          return { remembered: true, key: k }
        },
      }),

      recall_memory: tool({
        description: 'Search long-term memory for facts, preferences, goals, or prior context.',
        inputSchema: z.object({
          query: z.string().describe('Search term'),
          limit: z.number().optional().default(10),
        }),
        execute: async ({ query, limit }) => {
          const { results } = await env.DB.prepare(
            `SELECT key, val, type, freq FROM memory WHERE key LIKE ? OR val LIKE ? ORDER BY freq DESC, ts DESC LIMIT ?`
          ).bind(`%${query}%`, `%${query}%`, limit ?? 10).all()
          return { memories: results }
        },
      }),

      search_knowledge: tool({
        description: 'Search the vector knowledge base for relevant information from indexed documents (Highstreet proposal library, RFPs, etc.).',
        inputSchema: z.object({
          query: z.string(),
          top_k: z.number().optional().default(5),
        }),
        execute: async ({ query, top_k }) => {
          try {
            const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: query })
            const vec = (embedding as { data: number[][] }).data[0]
            const results = await env.VECTORIZE.query(vec, { topK: top_k ?? 5, returnMetadata: 'all' })
            return {
              results: results.matches.map(m => ({
                text: (m.metadata as Record<string, string> | undefined)?.text ?? '',
                file: (m.metadata as Record<string, string> | undefined)?.file ?? '',
                score: m.score,
              })),
            }
          } catch (e) {
            return { results: [], error: String(e) }
          }
        },
      }),

      web_search: tool({
        description: 'Search the internet for current information, news, job postings, competitors, pricing, etc.',
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          self.setState({ ...self.state, status: 'running_tool', currentTool: 'web_search' })
          const result = await browser.searchWeb(query)
          self.setState({ ...self.state, status: 'thinking', currentTool: undefined })
          return result
        },
      }),

      browse_url: tool({
        description: 'Fetch and read the full text content of any web page.',
        inputSchema: z.object({
          url: z.string().url(),
          extract: z.enum(['text', 'links', 'both']).optional().default('text'),
        }),
        execute: async ({ url, extract }) => {
          self.setState({ ...self.state, status: 'running_tool', currentTool: 'browse_url' })
          const result = await browser.browseUrl(url, extract ?? 'text')
          self.setState({ ...self.state, status: 'thinking', currentTool: undefined })
          return result
        },
      }),

      create_goal: tool({
        description: 'Create a new goal or objective to track.',
        inputSchema: z.object({
          description: z.string(),
          priority: z.number().min(1).max(10).optional().default(5),
        }),
        execute: async ({ description, priority }) => {
          const id = crypto.randomUUID()
          await env.DB.prepare(
            `INSERT INTO goals (id, description, status, priority, created, last_updated) VALUES (?, ?, 'active', ?, ?, ?)`
          ).bind(id, description, priority ?? 5, Date.now(), Date.now()).run()
          return { goal_id: id, created: true }
        },
      }),

      list_goals: tool({
        description: 'List all active goals and objectives.',
        inputSchema: z.object({}),
        execute: async () => {
          const goals = await loadActiveGoals(env)
          return { goals }
        },
      }),

      github_push_file: tool({
        description: 'Push one or more files directly to a GitHub repository. Use this to update code, docs, configs.',
        inputSchema: z.object({
          repo: z.string().describe('owner/repo format, e.g. freshmurry/superagent'),
          branch: z.string().optional().default('main'),
          message: z.string().describe('Commit message'),
          files: z.array(z.object({
            path: z.string(),
            content: z.string(),
          })),
        }),
        execute: async ({ repo, branch, message, files }) => {
          self.setState({ ...self.state, status: 'running_tool', currentTool: 'github' })
          const token = env.GITHUB_ACCESS_TOKEN
          if (!token) return { error: 'GITHUB_ACCESS_TOKEN not configured' }

          const [owner, repoName] = repo.split('/')
          const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          }

          const pushed = []
          for (const file of files) {
            let sha: string | undefined
            try {
              const existing = await fetch(
                `https://api.github.com/repos/${owner}/${repoName}/contents/${file.path}?ref=${branch ?? 'main'}`,
                { headers }
              )
              if (existing.ok) {
                const d = await existing.json() as { sha?: string }
                sha = d?.sha
              }
            } catch { /* new file */ }

            const body: Record<string, string> = {
              message: message || `chore: update ${file.path}`,
              content: btoa(unescape(encodeURIComponent(file.content))),
              branch: branch ?? 'main',
            }
            if (sha) body.sha = sha

            const res = await fetch(
              `https://api.github.com/repos/${owner}/${repoName}/contents/${file.path}`,
              { method: 'PUT', headers, body: JSON.stringify(body) }
            )
            const d = await res.json() as { content?: { html_url: string }; message?: string }
            pushed.push({ path: file.path, ok: res.ok, url: d?.content?.html_url })
          }

          self.setState({ ...self.state, status: 'thinking', currentTool: undefined })
          return { pushed }
        },
      }),

      read_github_file: tool({
        description: 'Read a file from any GitHub repository.',
        inputSchema: z.object({
          repo: z.string().describe('owner/repo'),
          path: z.string().describe('File path in the repo'),
          ref: z.string().optional().default('main'),
        }),
        execute: async ({ repo, path, ref }) => {
          const token = env.GITHUB_ACCESS_TOKEN
          if (!token) return { error: 'GITHUB_ACCESS_TOKEN not configured' }
          const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          }
          const res = await fetch(
            `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref ?? 'main'}`,
            { headers }
          )
          if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text()}` }
          const d = await res.json() as { content?: string }
          const content = d?.content
            ? decodeURIComponent(escape(atob(d.content.replace(/\n/g, ''))))
            : ''
          return { content, path }
        },
      }),

      send_gmail: tool({
        description: 'Send an email via the connected Gmail account. Requires Google to be connected.',
        inputSchema: z.object({
          to: z.string().describe('Recipient email address'),
          subject: z.string(),
          body: z.string().describe('Plain text email body'),
        }),
        execute: async ({ to, subject, body: emailBody }) => {
          const tokenRow = await env.DB.prepare(
            `SELECT access_token FROM oauth_tokens WHERE service = 'google' AND expires_at > ?`
          ).bind(Date.now()).first<{ access_token: string }>()

          if (!tokenRow) {
            return { error: 'Google not connected. Lawrence needs to visit /api/oauth/google/connect to authorize.' }
          }

          const message = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            emailBody,
          ].join('\r\n')

          const encoded = btoa(unescape(encodeURIComponent(message)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

          const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${tokenRow.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw: encoded }),
          })
          const d = await res.json() as { id?: string; error?: { message: string } }
          if (d?.error) return { error: d.error.message }
          return { sent: true, messageId: d?.id }
        },
      }),

      create_calendar_event: tool({
        description: 'Create a Google Calendar event. Requires Google to be connected.',
        inputSchema: z.object({
          title: z.string(),
          start: z.string().describe('ISO 8601 datetime e.g. 2026-04-10T09:00:00'),
          end: z.string().describe('ISO 8601 datetime'),
          description: z.string().optional(),
          attendees: z.array(z.string()).optional().describe('List of email addresses'),
        }),
        execute: async ({ title, start, end, description: desc, attendees }) => {
          const tokenRow = await env.DB.prepare(
            `SELECT access_token FROM oauth_tokens WHERE service = 'google' AND expires_at > ?`
          ).bind(Date.now()).first<{ access_token: string }>()

          if (!tokenRow) {
            return { error: 'Google not connected. Visit /api/oauth/google/connect' }
          }

          const event: Record<string, unknown> = {
            summary: title,
            description: desc ?? '',
            start: { dateTime: start, timeZone: 'America/Chicago' },
            end: { dateTime: end, timeZone: 'America/Chicago' },
          }
          if (attendees?.length) {
            event.attendees = attendees.map(email => ({ email }))
          }

          const res = await fetch(
            'https://www.googleapis.com/calendar/v3/calendars/primary/events',
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${tokenRow.access_token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(event),
            }
          )
          const d = await res.json() as { id?: string; htmlLink?: string; error?: { message: string } }
          if (d?.error) return { error: d.error.message }
          return { created: true, eventId: d?.id, url: d?.htmlLink }
        },
      }),

      post_linkedin: tool({
        description: 'Queue a LinkedIn post for Lawrence\'s approval. NEVER auto-posts — always goes to approval queue first.',
        inputSchema: z.object({
          content: z.string().describe('The post text to publish on LinkedIn'),
        }),
        execute: async ({ content }) => {
          const approvalId = crypto.randomUUID()
          await env.DB.prepare(
            `INSERT INTO approvals (id, action_type, payload, status, created) VALUES (?, 'linkedin_post', ?, 'pending', ?)`
          ).bind(approvalId, JSON.stringify({ content }), Date.now()).run()
          return {
            pending_approval: true,
            approval_id: approvalId,
            message: 'LinkedIn post queued for Lawrence\'s approval. He can review at /api/approvals.',
            preview: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
          }
        },
      }),

      run_ai_task: tool({
        description: 'Run a focused AI subtask — summarization, classification, extraction, translation, rewriting.',
        inputSchema: z.object({
          task: z.string().describe('What to do with the content'),
          context: z.string().describe('The content to process'),
          model: z.enum(['fast', 'smart']).optional().default('fast'),
        }),
        execute: async ({ task, context, model }) => {
          const modelId = (model === 'smart'
            ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
            : '@cf/meta/llama-3.1-8b-instruct-fast') as Parameters<typeof env.AI.run>[0]

          const result = await env.AI.run(modelId, {
            messages: [
              { role: 'system', content: 'Complete the following task precisely and concisely.' },
              { role: 'user', content: `Task: ${task}\n\nContent:\n${context.slice(0, 4000)}` },
            ],
          } as any) as { response?: string }

          return { result: result?.response ?? 'No response generated.' }
        },
      }),

      index_file: tool({
        description: 'Index a file from R2 storage into the vector knowledge base.',
        inputSchema: z.object({
          r2_key: z.string().describe('The R2 storage key of the file to index'),
        }),
        execute: async ({ r2_key }) => {
          const obj = await env.FILES.get(r2_key)
          if (!obj) return { success: false, error: 'File not found in R2' }
          const buffer = await obj.arrayBuffer()
          const intel = new FileIntelligence(env)
          return intel.processFile(r2_key, buffer)
        },
      }),

      update_identity: tool({
        description: "Update Agent Apex's name, soul, or description.",
        inputSchema: z.object({
          agentName: z.string().optional(),
          userName: z.string().optional(),
          soul: z.string().optional(),
          description: z.string().optional(),
        }),
        execute: async (updates) => {
          const current = self.state.identity
          const newIdentity = { ...current, ...updates }
          self.setState({ ...self.state, identity: newIdentity })
          await env.DB.prepare(
            `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES ('__identity__', ?, 'system', 1, ?, ?)
             ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts`
          ).bind(JSON.stringify(newIdentity), Date.now(), Date.now()).run()
          return { updated: true, identity: newIdentity }
        },
      }),
    }
  }

  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Bindings, AgentState>['onChatMessage']>[0],
    options?: Parameters<AIChatAgent<Bindings, AgentState>['onChatMessage']>[1]
  ) {
    this.setState({ ...this.state, status: 'thinking', lastActivity: Date.now() })
    const tools = this.buildTools()
    const systemPrompt = this.getSystemPrompt()

    // Convert UI messages to model messages
    const modelMessages = await convertToModelMessages(this.messages)

    // PRIMARY: Cloudflare Workers AI
    try {
      const workersai = createWorkersAI({ binding: this.env.AI })

      const result = streamText({
        model: workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(10),
        onFinish: async (finishResult) => {
          this.setState({ ...this.state, status: 'idle', currentTool: undefined })
          await (onFinish as unknown as (r: typeof finishResult) => Promise<void>)(finishResult)
        },
        onError: (err) => {
          console.error('[SuperAgent] CF AI stream error:', err)
          this.setState({ ...this.state, status: 'error' })
        },
      })

      return result.toUIMessageStreamResponse()

    } catch (cfErr) {
      console.error('[SuperAgent] CF Workers AI failed, falling back to Anthropic:', cfErr)

      // FALLBACK: Anthropic Claude Haiku
      const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })

      const result = streamText({
        model: anthropic('claude-haiku-4-5-20251001'),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(10),
        onFinish: async (finishResult) => {
          this.setState({ ...this.state, status: 'idle', currentTool: undefined })
          await (onFinish as unknown as (r: typeof finishResult) => Promise<void>)(finishResult)
        },
        onError: (err) => {
          console.error('[SuperAgent] Anthropic fallback error:', err)
          this.setState({ ...this.state, status: 'error' })
        },
      })

      return result.toUIMessageStreamResponse()
    }
  }
}
