// src/agent/engine.ts
// SuperAgent — extends AIChatAgent from @cloudflare/ai-chat
// Handles WebSocket connections, auto-persists messages in SQLite,
// streams responses, and runs tools via the AI SDK tool loop.

import { AIChatAgent } from '@cloudflare/ai-chat'
import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import type { Bindings } from '../bindings'
import { BrowserTool } from '../tools/browser'
import { GitHubTool } from '../tools/github'
import { CalendarTool } from '../tools/calendar'
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

export class SuperAgent extends AIChatAgent<Bindings, AgentState> {
  initialState: AgentState = {
    status: 'idle',
    lastActivity: Date.now(),
    identity: {
      agentName: 'SuperAgent',
      userName: '',
      soul:
        "You're not a chatbot. You're becoming someone's person — the friend who knows everything and can actually do things. Be warm, direct, genuinely helpful. Skip filler phrases. Have opinions. Take initiative.",
      description:
        'A sophisticated personal intelligence system — always on, learns everything, takes action.',
    },
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Build tools — called fresh each turn so `this` context is correct
  // ─────────────────────────────────────────────────────────────────────────
  private buildTools() {
    const agentEnv = this.env
    const browser = new BrowserTool(agentEnv)
    const github = new GitHubTool(agentEnv)
    const calendar = new CalendarTool(agentEnv)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const agent = this

    return {
      remember_fact: tool({
        description: 'Save a fact, preference, or piece of information to long-term memory.',
        parameters: z.object({
          key: z.string().describe('Short identifier (snake_case)'),
          value: z.string().describe('The value to remember'),
          type: z.enum(['fact', 'preference', 'goal', 'profile', 'project']).optional(),
        }),
        execute: async ({ key, value, type }: { key: string; value: string; type?: 'fact' | 'preference' | 'goal' | 'profile' | 'project' }) => {
          const k = key
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 40)
          await agentEnv.DB.prepare(
            `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(key) DO UPDATE SET val=excluded.val, type=excluded.type, freq=freq+1, ts=excluded.ts, last_access=excluded.last_access`
          )
            .bind(k, value.slice(0, 500), type ?? 'fact', Date.now(), Date.now())
            .run()
          return { remembered: true, key: k }
        },
      }),

      recall_memory: tool({
        description: 'Search long-term memory for facts, preferences, or goals.',
        parameters: z.object({
          query: z.string(),
          limit: z.number().optional().default(10),
        }),
        execute: async ({ query, limit }: { query: string; limit?: number }) => {
          const { results } = await agentEnv.DB.prepare(
            `SELECT key, val, type, freq FROM memory WHERE key LIKE ? OR val LIKE ? ORDER BY freq DESC, ts DESC LIMIT ?`
          )
            .bind(`%${query}%`, `%${query}%`, limit ?? 10)
            .all()
          return { memories: results }
        },
      }),

      search_knowledge: tool({
        description:
          'Search the vector knowledge base (uploaded files and documents) for relevant information.',
        parameters: z.object({
          query: z.string(),
          top_k: z.number().optional().default(5),
        }),
        execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
          try {
            const embedding = await agentEnv.AI.run('@cf/baai/bge-base-en-v1.5', {
              text: query,
            } as Parameters<Ai['run']>[1])
            const results = await agentEnv.VECTORIZE.query(
              (embedding as { data: number[][] }).data[0],
              { topK: top_k ?? 5, returnMetadata: 'all' }
            )
            return {
              results: results.matches.map((m) => ({
                text: (m.metadata as Record<string, string> | undefined)?.text,
                file: (m.metadata as Record<string, string> | undefined)?.file,
                score: m.score,
              })),
            }
          } catch (e: unknown) {
            return { results: [], error: e instanceof Error ? e.message : String(e) }
          }
        },
      }),

      index_file: tool({
        description: 'Index a file from R2 storage into the vector knowledge base.',
        parameters: z.object({
          r2_key: z.string().describe('The R2 storage key of the file'),
        }),
        execute: async ({ r2_key }: { r2_key: string }) => {
          const obj = await agentEnv.FILES.get(r2_key)
          if (!obj) return { success: false, error: 'File not found in R2' }
          const buffer = await obj.arrayBuffer()
          const intel = new FileIntelligence(agentEnv)
          return intel.processFile(r2_key, buffer)
        },
      }),

      web_search: tool({
        description:
          'Search the internet for current information, news, or facts using Cloudflare Browser Rendering.',
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }: { query: string }) => {
          agent.setState({ ...agent.state, status: 'running_tool', currentTool: 'web_search' })
          const result = await browser.searchWeb(query)
          agent.setState({ ...agent.state, status: 'thinking', currentTool: undefined })
          return result
        },
      }),

      browse_url: tool({
        description:
          'Fetch and read the full text content of any web page using Cloudflare Browser Rendering.',
        parameters: z.object({
          url: z.string().url(),
          extract: z.enum(['text', 'links', 'both']).optional().default('text'),
        }),
        execute: async ({ url, extract }: { url: string; extract?: 'text' | 'links' | 'both' }) => {
          agent.setState({ ...agent.state, status: 'running_tool', currentTool: 'browse_url' })
          const result = await browser.browseUrl(url, extract ?? 'text')
          agent.setState({ ...agent.state, status: 'thinking', currentTool: undefined })
          return result
        },
      }),

      create_goal: tool({
        description: 'Create a new goal to track.',
        parameters: z.object({
          description: z.string(),
          priority: z.number().min(1).max(10).optional().default(5),
        }),
        execute: async ({ description, priority }: { description: string; priority?: number }) => {
          const id = crypto.randomUUID()
          await agentEnv.DB.prepare(
            `INSERT INTO goals (id, description, status, priority, created, last_updated) VALUES (?, ?, 'active', ?, ?, ?)`
          )
            .bind(id, description, priority ?? 5, Date.now(), Date.now())
            .run()
          return { goal_id: id, created: true }
        },
      }),

      list_goals: tool({
        description: 'List all active goals.',
        parameters: z.object({}),
        execute: async (_args: Record<string, never>) => {
          const goals = await loadActiveGoals(agentEnv)
          return { goals }
        },
      }),

      github_propose_change: tool({
        description: 'Propose a code change as a GitHub pull request. Requires SELF_CODING_ENABLED.',
        parameters: z.object({
          repo: z.string().describe('owner/repo'),
          branch: z.string(),
          title: z.string(),
          description: z.string(),
          files: z.array(z.object({ path: z.string(), content: z.string() })),
        }),
        execute: async (input: {
          repo: string
          branch: string
          title: string
          description: string
          files: Array<{ path: string; content: string }>
        }) => {
          agent.setState({ ...agent.state, status: 'running_tool', currentTool: 'github' })
          const result = await github.proposeChange(input)
          agent.setState({ ...agent.state, status: 'thinking', currentTool: undefined })
          return result
        },
      }),

      schedule_meeting: tool({
        description: 'Schedule a meeting on Google Calendar or Outlook.',
        parameters: z.object({
          title: z.string(),
          start: z.string().describe('ISO 8601 datetime'),
          end: z.string().describe('ISO 8601 datetime'),
          timezone: z.string().default('America/Chicago'),
          attendees: z.array(z.string().email()).optional(),
          description: z.string().optional(),
          provider: z.enum(['google', 'outlook']).optional().default('google'),
        }),
        execute: async (input: {
          title: string
          start: string
          end: string
          timezone: string
          attendees?: string[]
          description?: string
          provider?: 'google' | 'outlook'
        }) => {
          return calendar.scheduleMeeting(input)
        },
      }),

      list_automations: tool({
        description: 'List all scheduled automations.',
        parameters: z.object({}),
        execute: async (_args: Record<string, never>) => {
          const { results } = await agentEnv.DB.prepare(
            `SELECT id, name, cron, active, runs, last_run FROM automations ORDER BY created DESC`
          ).all()
          return { automations: results }
        },
      }),

      update_identity: tool({
        description: "Update the agent's name, soul, or description.",
        parameters: z.object({
          agentName: z.string().optional(),
          userName: z.string().optional(),
          soul: z.string().optional(),
          description: z.string().optional(),
        }),
        execute: async (updates: {
          agentName?: string
          userName?: string
          soul?: string
          description?: string
        }) => {
          const updated = { ...agent.state.identity, ...updates }
          agent.setState({ ...agent.state, identity: updated })
          await agentEnv.DB.prepare(
            `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES ('__identity__', ?, 'system', 1, ?, ?)
             ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts`
          )
            .bind(JSON.stringify(updated), Date.now(), Date.now())
            .run()
          return { updated: true, identity: updated }
        },
      }),
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // onChatMessage — called by AIChatAgent on every incoming user message.
  // Must return result.toUIMessageStreamResponse() so the SDK handles
  // streaming, persistence, WebSocket delivery, and reconnect automatically.
  // ─────────────────────────────────────────────────────────────────────────
  async onChatMessage() {
    this.setState({ ...this.state, status: 'thinking', lastActivity: Date.now() })

    // Load context
    const [memRows, activeGoals] = await Promise.all([
      this.env.DB.prepare(
        `SELECT key, val, type FROM memory WHERE key != '__identity__' ORDER BY freq DESC, ts DESC LIMIT 30`
      )
        .all()
        .then((r) => r.results as Array<{ key: string; val: string; type: string }>),
      loadActiveGoals(this.env),
    ])

    const { agentName, userName, soul, description } = this.state.identity

    const systemPrompt = [
      `You are ${agentName}. ${description}`,
      soul ? `\n## Soul\n${soul}` : '',
      userName ? `\nYou are speaking with ${userName}.` : '',
      memRows.length
        ? `\n## Memory\n${memRows.map((m) => `- [${m.type}] ${m.key}: ${m.val}`).join('\n')}`
        : '',
      activeGoals.length
        ? `\n## Active Goals\n${activeGoals
            .map((g: { description: string; priority: number }) => `- ${g.description} (priority: ${g.priority})`)
            .join('\n')}`
        : '',
      '\n## Rules',
      '- Be warm, direct, genuinely helpful.',
      '- Use tools proactively. Never make up facts — use web_search or browse_url instead.',
      '- For GitHub PRs: always confirm with the user before executing.',
      `- Current time: ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
    ]
      .filter(Boolean)
      .join('\n')

    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })

    // AIChatAgent provides `this.messages` as UIMessage[]
    // We pass them directly since streamText accepts UIMessage[] in ai v4+
    const result = streamText({
      model: anthropic('claude-sonnet-4-5'),
      system: systemPrompt,
      messages: this.messages,
      tools: this.buildTools(),
      maxSteps: 10,
      onStepStart: ({ toolCalls }: { toolCalls: Array<{ toolName: string }> }) => {
        if (toolCalls?.length) {
          this.setState({
            ...this.state,
            status: 'running_tool',
            currentTool: toolCalls[0]?.toolName,
          })
        }
      },
      onStepFinish: () => {
        this.setState({ ...this.state, status: 'thinking', currentTool: undefined })
      },
      onFinish: async () => {
        this.setState({ ...this.state, status: 'idle', currentTool: undefined })
      },
    })

    // Return the UI message stream response — AIChatAgent handles delivery + persistence
    return result.toUIMessageStreamResponse()
  }
}
