// src/agent/engine.ts
// SuperAgent — extends AIChatAgent from @cloudflare/ai-chat
// ai SDK v6: uses `inputSchema` (not `parameters`), `stopWhen` (not `maxSteps`),
// and convertToModelMessages must be awaited.

import { AIChatAgent } from '@cloudflare/ai-chat'
import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, convertToModelMessages, stepCountIs } from 'ai'
import { z } from 'zod'
import type { Bindings } from '../bindings'
import { BrowserTool } from '../tools/browser'
import { GitHubTool } from '../tools/github'
import { CalendarTool } from '../tools/calendar'
import { FileIntelligence } from './file-intelligence'
import { loadActiveGoals, type Goal } from './goals-store'

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
  // Build tools — ai v6 API: `inputSchema` instead of `parameters`
  // execute(input, options) — input is inferred from the schema
  // ─────────────────────────────────────────────────────────────────────────
  private buildTools() {
    const agentEnv = this.env
    const browser = new BrowserTool(agentEnv)
    const github = new GitHubTool(agentEnv)
    const calendar = new CalendarTool(agentEnv)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const agent = this

    return {
      remember_fact: {
        description: 'Save a fact, preference, or piece of information to long-term memory.',
        inputSchema: z.object({
          key: z.string().describe('Short identifier (snake_case)'),
          value: z.string().describe('The value to remember'),
          type: z.enum(['fact', 'preference', 'goal', 'profile', 'project']).optional(),
        }),
        execute: async (input: { key: string; value: string; type?: 'fact' | 'preference' | 'goal' | 'profile' | 'project' }) => {
          const k = input.key
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 40)
          await agentEnv.DB.prepare(
            `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(key) DO UPDATE SET val=excluded.val, type=excluded.type, freq=freq+1, ts=excluded.ts, last_access=excluded.last_access`
          ).bind(k, input.value.slice(0, 500), input.type ?? 'fact', Date.now(), Date.now()).run()
          return { remembered: true, key: k }
        },
      },

      recall_memory: {
        description: 'Search long-term memory for facts, preferences, or goals.',
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().optional().default(10),
        }),
        execute: async (input: { query: string; limit?: number }) => {
          const { results } = await agentEnv.DB.prepare(
            `SELECT key, val, type, freq FROM memory WHERE key LIKE ? OR val LIKE ? ORDER BY freq DESC, ts DESC LIMIT ?`
          ).bind(`%${input.query}%`, `%${input.query}%`, input.limit ?? 10).all()
          return { memories: results }
        },
      },

      search_knowledge: {
        description: 'Search the vector knowledge base for relevant information.',
        inputSchema: z.object({
          query: z.string(),
          top_k: z.number().optional().default(5),
        }),
        execute: async (input: { query: string; top_k?: number }) => {
          try {
            const embedding = await agentEnv.AI.run('@cf/baai/bge-base-en-v1.5', { text: input.query })
            const vec = (embedding as { data: number[][] }).data[0]
            const results = await agentEnv.VECTORIZE.query(vec, {
              topK: input.top_k ?? 5,
              returnMetadata: 'all',
            })
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
      },

      index_file: {
        description: 'Index a file from R2 storage into the vector knowledge base.',
        inputSchema: z.object({
          r2_key: z.string().describe('The R2 storage key of the file'),
        }),
        execute: async (input: { r2_key: string }) => {
          const obj = await agentEnv.FILES.get(input.r2_key)
          if (!obj) return { success: false, error: 'File not found in R2' }
          const buffer = await obj.arrayBuffer()
          const intel = new FileIntelligence(agentEnv)
          return intel.processFile(input.r2_key, buffer)
        },
      },

      web_search: {
        description: 'Search the internet using Cloudflare Browser Rendering.',
        inputSchema: z.object({ query: z.string() }),
        execute: async (input: { query: string }) => {
          agent.setState({ ...agent.state, status: 'running_tool', currentTool: 'web_search' })
          const result = await browser.searchWeb(input.query)
          agent.setState({ ...agent.state, status: 'thinking', currentTool: undefined })
          return result
        },
      },

      browse_url: {
        description: 'Fetch and read the full text content of any web page.',
        inputSchema: z.object({
          url: z.string().url(),
          extract: z.enum(['text', 'links', 'both']).optional().default('text'),
        }),
        execute: async (input: { url: string; extract?: 'text' | 'links' | 'both' }) => {
          agent.setState({ ...agent.state, status: 'running_tool', currentTool: 'browse_url' })
          const result = await browser.browseUrl(input.url, input.extract ?? 'text')
          agent.setState({ ...agent.state, status: 'thinking', currentTool: undefined })
          return result
        },
      },

      create_goal: {
        description: 'Create a new goal to track.',
        inputSchema: z.object({
          description: z.string(),
          priority: z.number().min(1).max(10).optional().default(5),
        }),
        execute: async (input: { description: string; priority?: number }) => {
          const id = crypto.randomUUID()
          await agentEnv.DB.prepare(
            `INSERT INTO goals (id, description, status, priority, created, last_updated) VALUES (?, ?, 'active', ?, ?, ?)`
          ).bind(id, input.description, input.priority ?? 5, Date.now(), Date.now()).run()
          return { goal_id: id, created: true }
        },
      },

      list_goals: {
        description: 'List all active goals.',
        inputSchema: z.object({}),
        execute: async (_input: Record<string, never>) => {
          const goals = await loadActiveGoals(agentEnv)
          return { goals }
        },
      },

      github_propose_change: {
        description: 'Propose a code change as a GitHub pull request.',
        inputSchema: z.object({
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
      },

      schedule_meeting: {
        description: 'Schedule a meeting on Google Calendar or Outlook.',
        inputSchema: z.object({
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
      },

      list_automations: {
        description: 'List all scheduled automations.',
        inputSchema: z.object({}),
        execute: async (_input: Record<string, never>) => {
          const { results } = await agentEnv.DB.prepare(
            `SELECT id, name, cron, active, runs, last_run FROM automations ORDER BY created DESC`
          ).all()
          return { automations: results }
        },
      },

      update_identity: {
        description: "Update the agent's name, soul, or description.",
        inputSchema: z.object({
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
          ).bind(JSON.stringify(updated), Date.now(), Date.now()).run()
          return { updated: true, identity: updated }
        },
      },
    } as const
  }

  // ─────────────────────────────────────────────────────────────────────────
  // onChatMessage — called by AIChatAgent on every incoming user message
  // ─────────────────────────────────────────────────────────────────────────
  async onChatMessage() {
    this.setState({ ...this.state, status: 'thinking', lastActivity: Date.now() })

    const [memRows, activeGoals] = await Promise.all([
      this.env.DB.prepare(
        `SELECT key, val, type FROM memory WHERE key != '__identity__' ORDER BY freq DESC, ts DESC LIMIT 30`
      )
        .all<{ key: string; val: string; type: string }>()
        .then((r) => r.results),
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
            .map((g: Goal) => `- ${g.description} (priority: ${g.priority})`)
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

    // convertToModelMessages is async in ai v6
    const modelMessages = await convertToModelMessages(this.messages)

    const result = streamText({
      model: anthropic('claude-sonnet-4-5'),
      system: systemPrompt,
      messages: modelMessages,
      tools: this.buildTools(),
      // ai v6: maxSteps replaced by stopWhen + stepCountIs
      stopWhen: stepCountIs(10),
      onStepFinish: ({ toolCalls }: { toolCalls?: Array<{ toolName: string }> }) => {
        if (toolCalls?.length) {
          this.setState({
            ...this.state,
            status: 'running_tool',
            currentTool: toolCalls[0]?.toolName,
          })
        } else {
          this.setState({ ...this.state, status: 'thinking', currentTool: undefined })
        }
      },
      onFinish: async () => {
        this.setState({ ...this.state, status: 'idle', currentTool: undefined })
      },
    })

    return result.toUIMessageStreamResponse()
  }
}
