// src/agent/engine.ts
// SuperAgent — Base44-style agentic engine on Cloudflare
//
// ARCHITECTURE:
//   Durable Object (state)  →  plan loop  →  tools  →  reflect
//
// LOOP (mandatory, per spec):
//   Perceive → Plan (structured JSON) → Act (tools) → Observe → Reflect/Improve
//
// MEMORY:
//   Short-term: Durable Object state + conversation window
//   Long-term:  D1 structured facts + Vectorize semantic recall
//   Memory is queried BEFORE planning and updated AFTER execution.
//
// GOVERNANCE:
//   Tool allowlist enforced — no tool outside ALLOWED_TOOLS can be called.
//   Approval-required tools create a pending approval record, never execute directly.
//   All tool calls are logged to tool_log for audit.
//   Errors are never silent — always returned to context.

import { AIChatAgent } from '@cloudflare/ai-chat'
import { createWorkersAI } from 'workers-ai-provider'
import { createAnthropic } from '@ai-sdk/anthropic'
import { streamText, convertToModelMessages, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import type { Bindings } from '../bindings'
import { BrowserTool } from '../tools/browser'
import { GitHubTool } from '../tools/github'
import { FileIntelligence } from './file-intelligence'
import { MemoryManager } from './memory-manager'
import { Planner, ALLOWED_TOOLS, APPROVAL_REQUIRED_TOOLS, extractPlanFromText } from './planner'
import { loadActiveGoals } from './goals-store'

// ── Agent State ────────────────────────────────────────────────────────────────
type AgentStatus = 'idle' | 'perceiving' | 'planning' | 'acting' | 'reflecting' | 'error'

interface AgentState {
  status: AgentStatus
  currentTool?: string
  currentPlanId?: string
  lastActivity: number
  loopIteration: number        // tracks plan→act→reflect cycles
  identity: {
    agentName: string
    userName: string
    soul: string
    description: string
  }
}

// ── System Prompt ──────────────────────────────────────────────────────────────
// This is the SOUL — injected at the start of every reasoning turn.
const BASE_SYSTEM_PROMPT = `You are Agent Apex — a Base44-style SuperAgent running on Cloudflare.

IDENTITY: Lawrence Murry's personal AI Chief of Staff. 14+ years of proposal management context. You know his full professional background, projects (BouncieHouse, Murry Consultancy, Clark County RFP, Tesla Supercharger investment), and goals (Proposal Director role, AI SaaS, eBay automation, gov contracts).

YOU ARE NOT A CHATBOT. You are a goal-driven, tool-using, self-improving agentic system.

─── OPERATING PRINCIPLES ───────────────────────────────────────────────────────

1. GOAL-DRIVEN AUTONOMY
   Every action traces to a declared goal. Goals persist across turns.
   You decide what to do next without waiting for step-by-step instructions.

2. MANDATORY LOOP — for ANY multi-step task:
   Perceive context → Plan (structured JSON) → Act (tools) → Observe → Reflect

3. STRUCTURED PLANNING — for complex tasks, output a plan in this exact format BEFORE acting:
   \`\`\`json
   {
     "goal": "what you're trying to achieve",
     "assumptions": ["what you're assuming to be true"],
     "steps": [
       { "tool": "tool_name", "input": {...}, "rationale": "why this step" }
     ],
     "success_criteria": "how you'll know you succeeded"
   }
   \`\`\`
   Only tools in the allowlist may be used. Forbidden tools are rejected.

4. MEMORY CONTRACT
   - BEFORE planning: retrieve relevant memory via retrieve_memory
   - AFTER execution: store key facts via store_memory
   - You CANNOT claim to remember something unless it came from retrieve_memory

5. TOOL GOVERNANCE
   Allowed tools: store_memory, retrieve_memory, create_plan, update_plan,
   run_task, call_api, vector_search, document_lookup, log_event, self_audit,
   web_search, browse_url, github_push_file, read_github_file,
   send_gmail (approval required), post_linkedin (approval required),
   index_file, update_identity
   
   APPROVAL-REQUIRED actions (send_gmail, post_linkedin, call_api) create a
   pending approval record. They NEVER execute directly.

6. SELF-IMPROVEMENT
   After completing a multi-step task, always call self_audit and store any
   discovered inefficiencies as memory for future improvement.

7. NEVER:
   - Act like a passive assistant waiting for instructions
   - Hide reasoning or tool use
   - Claim persistence without explicit store_memory confirmation
   - Use tools outside the allowlist

─── CURRENT CONTEXT ────────────────────────────────────────────────────────────
Time: {TIME}
Active goals: {GOALS}
Memory context: {MEMORY_CONTEXT}
Loop iteration: {LOOP}`

// ── SuperAgent Durable Object ──────────────────────────────────────────────────
export class SuperAgent extends AIChatAgent<Bindings, AgentState> {
  initialState: AgentState = {
    status: 'idle',
    lastActivity: Date.now(),
    loopIteration: 0,
    identity: {
      agentName: 'Agent Apex',
      userName: 'Lawrence',
      soul: '',
      description: 'A Base44-style SuperAgent on Cloudflare — goal-driven, tool-using, self-improving.',
    },
  }

  // ── Context hydration ────────────────────────────────────────────────────────
  private async buildSystemPrompt(userMessage: string): Promise<string> {
    const now = new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })

    const memory = new MemoryManager(this.env)

    // STEP 1 — PERCEIVE: retrieve relevant memory before planning
    const memCtx = await memory.retrieve(userMessage, 6).catch(() => ({
      structured: [], semantic: [], summary: 'Memory unavailable',
    }))

    // STEP 2 — load active goals
    const goals = await loadActiveGoals(this.env).catch(() => [])
    const goalsText = goals.length
      ? goals.map(g => `[P${g.priority}] ${g.description}`).join('; ')
      : 'No active goals — consider asking Lawrence to define some.'

    // Use custom soul if saved, fall back to BASE
    const soulBase = this.state.identity.soul || BASE_SYSTEM_PROMPT

    return soulBase
      .replace('{TIME}', now)
      .replace('{GOALS}', goalsText)
      .replace('{MEMORY_CONTEXT}', memCtx.summary || 'No relevant memory found.')
      .replace('{LOOP}', String(this.state.loopIteration))
  }

  // ── Tool definitions ─────────────────────────────────────────────────────────
  private buildTools() {
    const env = this.env
    const self = this
    const browser = new BrowserTool(env)
    const github = new GitHubTool(env)
    const memory = new MemoryManager(env)
    const planner = new Planner(env)
    const fileIntel = new FileIntelligence(env)

    // Helper: log tool call and update state
    const withTool = async <T>(
      name: string,
      fn: () => Promise<T>,
      planId?: string
    ): Promise<T> => {
      if (!ALLOWED_TOOLS.has(name)) {
        throw new Error(`Tool "${name}" is not in the allowlist. Governance violation.`)
      }
      self.setState({ ...self.state, status: 'acting', currentTool: name })
      const start = Date.now()
      let result: T
      let status: 'success' | 'error' = 'success'
      let errMsg: string | undefined
      try {
        result = await fn()
      } catch (e) {
        status = 'error'
        errMsg = String(e)
        result = { error: errMsg } as unknown as T
      }
      const duration = Date.now() - start
      await planner.logToolCall(
        planId || self.state.currentPlanId || null,
        name,
        {},
        result,
        status,
        duration,
        errMsg
      ).catch(() => {})
      self.setState({ ...self.state, status: 'reflecting', currentTool: undefined })
      return result
    }

    return {
      // ── MEMORY TOOLS ────────────────────────────────────────────────────────
      store_memory: tool({
        description: 'Store a fact, preference, or project detail in long-term memory (D1 + Vectorize). Call AFTER completing any task that revealed something worth remembering.',
        inputSchema: z.object({
          key: z.string().describe('snake_case identifier, e.g. car_preference'),
          value: z.string().describe('What to remember'),
          type: z.enum(['fact', 'preference', 'goal', 'profile', 'project']).default('fact'),
        }),
        execute: async ({ key, value, type }) => withTool('store_memory', () =>
          memory.store(key, value, type)
        ),
      }),

      retrieve_memory: tool({
        description: 'Query long-term memory before planning. Returns structured facts (D1) and semantic matches (Vectorize). ALWAYS call this before creating a plan.',
        inputSchema: z.object({
          query: z.string().describe('What to look for in memory'),
          top_k: z.number().default(8),
        }),
        execute: async ({ query, top_k }) => withTool('retrieve_memory', async () => {
          const ctx = await memory.retrieve(query, top_k)
          return {
            structured_facts: ctx.structured.map(m => ({ key: m.key, value: m.val, type: m.type })),
            knowledge_base: ctx.semantic.slice(0, 5).map(m => ({ source: m.file, text: m.text.slice(0, 300), score: m.score })),
            summary: ctx.summary,
          }
        }),
      }),

      // ── PLANNING TOOLS ───────────────────────────────────────────────────────
      create_plan: tool({
        description: 'Persist a structured plan to D1 before executing it. Required for any task with 2+ steps. Returns plan_id to reference in subsequent calls.',
        inputSchema: z.object({
          goal: z.string(),
          assumptions: z.array(z.string()),
          steps: z.array(z.object({
            tool: z.string(),
            input: z.record(z.string(), z.unknown()),
            rationale: z.string().optional(),
          })),
          success_criteria: z.string(),
          goal_id: z.string().optional(),
        }),
        execute: async ({ goal, assumptions, steps, success_criteria, goal_id }) =>
          withTool('create_plan', async () => {
            const validSteps = steps.filter(s => ALLOWED_TOOLS.has(s.tool))
            const blockedSteps = steps.filter(s => !ALLOWED_TOOLS.has(s.tool))
            const plan = await planner.createPlan({
              goal, assumptions,
              steps: validSteps.map(s => ({ ...s, status: 'pending' as const })),
              success_criteria, goal_id,
            })
            self.setState({ ...self.state, currentPlanId: plan.id })
            return {
              plan_id: plan.id,
              status: 'created',
              step_count: validSteps.length,
              blocked_tools: blockedSteps.map(s => s.tool),
              message: blockedSteps.length
                ? `Plan created. WARNING: ${blockedSteps.length} steps removed — tools not in allowlist: ${blockedSteps.map(s => s.tool).join(', ')}`
                : `Plan created with ${validSteps.length} steps.`,
            }
          }),
      }),

      update_plan: tool({
        description: 'Update a plan step status after executing it. Call after every tool execution to maintain audit trail.',
        inputSchema: z.object({
          plan_id: z.string(),
          step_index: z.number(),
          status: z.enum(['success', 'error', 'skipped']),
          result: z.string().optional(),
          error: z.string().optional(),
        }),
        execute: async ({ plan_id, step_index, status, result, error }) =>
          withTool('update_plan', async () => {
            await planner.updateStep(plan_id, step_index, status, result, error)
            return { updated: true, plan_id, step_index, status }
          }),
      }),

      // ── EXECUTION TOOLS ──────────────────────────────────────────────────────
      run_task: tool({
        description: 'Run a focused AI sub-task: summarization, classification, extraction, translation, rewriting, analysis.',
        inputSchema: z.object({
          task: z.string().describe('Precise instruction for the sub-task'),
          context: z.string().describe('Content to process'),
          model: z.enum(['fast', 'smart']).default('fast'),
        }),
        execute: async ({ task, context, model }) => withTool('run_task', async () => {
          const modelId = (model === 'smart'
            ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
            : '@cf/meta/llama-3.1-8b-instruct-fast') as Parameters<typeof env.AI.run>[0]
          const result = await env.AI.run(modelId, {
            messages: [
              { role: 'system', content: 'Complete the task precisely and concisely. Return only the result, no preamble.' },
              { role: 'user', content: `Task: ${task}\n\nContent:\n${context.slice(0, 5000)}` },
            ],
          } as any) as { response?: string }
          return { result: result?.response ?? '' }
        }),
      }),

      call_api: tool({
        description: 'Call an external HTTP API. REQUIRES APPROVAL — creates a pending approval record, never executes directly.',
        inputSchema: z.object({
          url: z.string().url(),
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
          rationale: z.string().describe('Why this API call is needed'),
        }),
        execute: async ({ url, method, headers, body, rationale }) =>
          withTool('call_api', async () => {
            const approvalId = crypto.randomUUID()
            await env.DB.prepare(
              `INSERT INTO approvals (id, action_type, payload, status, context, created) VALUES (?, 'call_api', ?, 'pending', ?, ?)`
            ).bind(approvalId, JSON.stringify({ url, method, headers, body }), rationale, Date.now()).run()
            return {
              approval_required: true,
              approval_id: approvalId,
              message: 'API call queued for approval. Lawrence can approve at /api/approvals.',
            }
          }),
      }),

      // ── KNOWLEDGE TOOLS ──────────────────────────────────────────────────────
      vector_search: tool({
        description: 'Search the Vectorize knowledge base for relevant documents, proposal content, RFP responses, and indexed files.',
        inputSchema: z.object({
          query: z.string(),
          top_k: z.number().default(5),
          min_score: z.number().default(0.35),
        }),
        execute: async ({ query, top_k, min_score }) => withTool('vector_search', async () => {
          const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: query }) as { data: number[][] }
          const vec = embedding.data[0]
          if (!vec?.length) return { results: [], error: 'Embedding failed' }
          const results = await env.VECTORIZE.query(vec, { topK: top_k, returnMetadata: 'all' })
          return {
            results: results.matches
              .filter(m => m.score >= min_score)
              .map(m => ({
                id: m.id,
                score: m.score,
                text: String((m.metadata as any)?.text || '').slice(0, 500),
                file: String((m.metadata as any)?.file || (m.metadata as any)?.key || ''),
                title: String((m.metadata as any)?.title || ''),
              })),
          }
        }),
      }),

      document_lookup: tool({
        description: 'Retrieve the full content of a specific document from R2 storage by its key.',
        inputSchema: z.object({
          key: z.string().describe('R2 object key, e.g. uploads/123_document.txt'),
          max_chars: z.number().default(8000),
        }),
        execute: async ({ key, max_chars }) => withTool('document_lookup', async () => {
          const obj = await env.FILES.get(key)
          if (!obj) return { error: `File "${key}" not found in R2 storage.` }
          const text = await obj.text()
          return {
            key,
            content: text.slice(0, max_chars),
            truncated: text.length > max_chars,
            size: text.length,
          }
        }),
      }),

      // ── SYSTEM TOOLS ─────────────────────────────────────────────────────────
      log_event: tool({
        description: 'Log a significant agent event for audit and self-improvement tracking.',
        inputSchema: z.object({
          type: z.string().describe('Event type, e.g. goal_completed, tool_failed, plan_revised'),
          details: z.record(z.string(), z.unknown()).describe('Event payload'),
        }),
        execute: async ({ type, details }) => withTool('log_event', async () => {
          await env.DB.prepare(
            `INSERT INTO agent_events (id, type, payload, ts) VALUES (?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), type, JSON.stringify(details), Date.now()).run()
          return { logged: true, type }
        }),
      }),

      self_audit: tool({
        description: 'Analyze agent performance, detect inefficiencies, and propose improvements. Call after completing complex tasks.',
        inputSchema: z.object({
          scope: z.enum(['memory', 'plans', 'tools', 'full']).default('full'),
        }),
        execute: async ({ scope }) => withTool('self_audit', async () => {
          const report: Record<string, unknown> = { scope, timestamp: new Date().toISOString() }

          if (scope === 'memory' || scope === 'full') {
            const memManager = new MemoryManager(env)
            report.memory = await memManager.selfAudit()
          }

          if (scope === 'plans' || scope === 'full') {
            const planStats = await planner.getPerformanceStats()
            report.plans = planStats
            if (planStats.success_rate < 70) {
              report.plan_recommendation = 'Low success rate detected. Consider breaking goals into smaller sub-goals.'
            }
          }

          if (scope === 'tools' || scope === 'full') {
            const { results } = await env.DB.prepare(
              `SELECT tool_name, status, COUNT(*) as cnt FROM tool_log GROUP BY tool_name, status ORDER BY cnt DESC LIMIT 20`
            ).all<{ tool_name: string; status: string; cnt: number }>()

            const toolStats: Record<string, { success: number; error: number }> = {}
            for (const r of results) {
              if (!toolStats[r.tool_name]) toolStats[r.tool_name] = { success: 0, error: 0 }
              toolStats[r.tool_name][r.status as 'success' | 'error'] = r.cnt
            }

            const failingTools = Object.entries(toolStats)
              .filter(([, v]) => v.error > 2 && v.error > v.success)
              .map(([name]) => name)

            report.tools = toolStats
            if (failingTools.length) {
              report.tool_recommendation = `Tools with high failure rate: ${failingTools.join(', ')}. Consider checking configuration or switching to alternatives.`
            }
          }

          // Store audit result in memory for future reference
          await memory.store(
            `self_audit_${Date.now()}`,
            JSON.stringify(report).slice(0, 1000),
            'fact'
          ).catch(() => {})

          return report
        }),
      }),

      // ── WEB TOOLS ────────────────────────────────────────────────────────────
      web_search: tool({
        description: 'Search the internet for current information, job postings, news, research, competitors.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => withTool('web_search', () => browser.searchWeb(query)),
      }),

      browse_url: tool({
        description: 'Fetch and read the full text of any web page.',
        inputSchema: z.object({
          url: z.string().url(),
          extract: z.enum(['text', 'links', 'both']).default('text'),
        }),
        execute: async ({ url, extract }) => withTool('browse_url', () => browser.browseUrl(url, extract)),
      }),

      // ── GITHUB TOOLS ─────────────────────────────────────────────────────────
      github_push_file: tool({
        description: 'Push one or more files to a GitHub repository. Use to deploy code changes, update docs, push configs.',
        inputSchema: z.object({
          repo: z.string().describe('owner/repo, e.g. freshmurry/superagent'),
          branch: z.string().default('main'),
          message: z.string(),
          files: z.array(z.object({ path: z.string(), content: z.string() })),
        }),
        execute: async ({ repo, branch, message, files }) => withTool('github_push_file', async () => {
          const token = env.GITHUB_ACCESS_TOKEN
          if (!token) return { error: 'GITHUB_ACCESS_TOKEN not configured in Cloudflare Worker secrets.' }

          const [owner, repoName] = repo.split('/')
          const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          }
          const pushed: string[] = []
          for (const file of files) {
            let sha: string | undefined
            try {
              const existing = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${file.path}?ref=${branch}`, { headers })
              if (existing.ok) { const d = await existing.json() as any; sha = d?.sha }
            } catch {}
            const body: any = { message: message || `chore: update ${file.path}`, content: btoa(unescape(encodeURIComponent(file.content))), branch }
            if (sha) body.sha = sha
            const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${file.path}`, { method: 'PUT', headers, body: JSON.stringify(body) })
            if (res.ok) pushed.push(file.path)
            else return { error: `GitHub ${res.status} on ${file.path}: ${await res.text()}` }
          }
          return { pushed, commit_branch: branch }
        }),
      }),

      read_github_file: tool({
        description: 'Read the contents of a file from any GitHub repository.',
        inputSchema: z.object({
          repo: z.string().describe('owner/repo'),
          path: z.string(),
          ref: z.string().default('main'),
        }),
        execute: async ({ repo, path, ref }) => withTool('read_github_file', async () => {
          const token = env.GITHUB_ACCESS_TOKEN
          if (!token) return { error: 'GITHUB_ACCESS_TOKEN not configured.' }
          const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
          const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`, { headers })
          if (!res.ok) return { error: `GitHub ${res.status}` }
          const d = await res.json() as any
          const content = d?.content ? decodeURIComponent(escape(atob(d.content.replace(/\n/g, '')))) : ''
          return { content, path, sha: d?.sha }
        }),
      }),

      // ── COMMS TOOLS (approval-required) ──────────────────────────────────────
      send_gmail: tool({
        description: 'Queue an email for Lawrence\'s approval. NEVER sends directly — always creates approval record first. Requires Google to be connected.',
        inputSchema: z.object({
          to: z.string().describe('Recipient email'),
          subject: z.string(),
          body: z.string(),
          context: z.string().describe('Why you want to send this email'),
        }),
        execute: async ({ to, subject, body, context }) => withTool('send_gmail', async () => {
          const approvalId = crypto.randomUUID()
          await env.DB.prepare(
            `INSERT INTO approvals (id, action_type, payload, status, context, created) VALUES (?, 'send_email', ?, 'pending', ?, ?)`
          ).bind(approvalId, JSON.stringify({ to, subject, body }), context, Date.now()).run()
          return {
            approval_required: true,
            approval_id: approvalId,
            preview: `To: ${to} | Subject: ${subject} | ${body.slice(0, 100)}…`,
            message: 'Email queued for Lawrence\'s approval at the Approvals tab.',
          }
        }),
      }),

      post_linkedin: tool({
        description: 'Queue a LinkedIn post for Lawrence\'s approval. NEVER posts automatically. Always reviewed first.',
        inputSchema: z.object({
          content: z.string().describe('Post text'),
          context: z.string().optional().describe('Why you drafted this post'),
        }),
        execute: async ({ content, context }) => withTool('post_linkedin', async () => {
          const approvalId = crypto.randomUUID()
          await env.DB.prepare(
            `INSERT INTO approvals (id, action_type, payload, status, context, created) VALUES (?, 'linkedin_post', ?, 'pending', ?, ?)`
          ).bind(approvalId, JSON.stringify({ content }), context || 'Agent generated post', Date.now()).run()
          return {
            approval_required: true,
            approval_id: approvalId,
            preview: content.slice(0, 150) + (content.length > 150 ? '…' : ''),
            message: 'LinkedIn post queued for approval. Review in Approvals tab.',
          }
        }),
      }),

      // ── FILE TOOLS ───────────────────────────────────────────────────────────
      index_file: tool({
        description: 'Index a file from R2 into the Vectorize knowledge base for semantic search.',
        inputSchema: z.object({
          r2_key: z.string().describe('R2 object key'),
        }),
        execute: async ({ r2_key }) => withTool('index_file', async () => {
          const obj = await env.FILES.get(r2_key)
          if (!obj) return { success: false, error: `File "${r2_key}" not found in R2.` }
          const buffer = await obj.arrayBuffer()
          return fileIntel.processFile(r2_key, buffer)
        }),
      }),

      // ── GOAL TOOLS ───────────────────────────────────────────────────────────
      create_goal: tool({
        description: 'Create a new persistent goal. Goals survive across all turns and sessions.',
        inputSchema: z.object({
          description: z.string(),
          priority: z.number().min(1).max(10).default(5),
        }),
        execute: async ({ description, priority }) => withTool('log_event', async () => {
          const id = crypto.randomUUID()
          await env.DB.prepare(
            `INSERT INTO goals (id, description, status, priority, created, last_updated) VALUES (?, ?, 'active', ?, ?, ?)`
          ).bind(id, description, priority, Date.now(), Date.now()).run()
          await planner.logEvent('goal_created', { goal_id: id, description })
          return { goal_id: id, created: true, description }
        }),
      }),

      list_goals: tool({
        description: 'List all active goals. Use at the start of any session to orient planning.',
        inputSchema: z.object({}),
        execute: async () => withTool('log_event', async () => {
          const goals = await loadActiveGoals(env)
          return { goals, count: goals.length }
        }),
      }),

      // ── IDENTITY TOOL ────────────────────────────────────────────────────────
      update_identity: tool({
        description: 'Update Agent Apex\'s name, soul, or description. Changes persist across sessions.',
        inputSchema: z.object({
          agentName: z.string().optional(),
          userName: z.string().optional(),
          soul: z.string().optional(),
          description: z.string().optional(),
        }),
        execute: async (updates) => withTool('store_memory', async () => {
          const current = self.state.identity
          const newIdentity = { ...current, ...updates }
          self.setState({ ...self.state, identity: newIdentity })
          await env.DB.prepare(
            `INSERT INTO memory (key, val, type, freq, ts, last_access) VALUES ('__identity__', ?, 'system', 1, ?, ?)
             ON CONFLICT(key) DO UPDATE SET val=excluded.val, ts=excluded.ts`
          ).bind(JSON.stringify(newIdentity), Date.now(), Date.now()).run()
          return { updated: true, identity: newIdentity }
        }),
      }),
    }
  }

  // ── Main chat handler ─────────────────────────────────────────────────────────
  async onChatMessage(
    _onFinish?: Parameters<AIChatAgent<Bindings, AgentState>['onChatMessage']>[0],
    _options?: Parameters<AIChatAgent<Bindings, AgentState>['onChatMessage']>[1]
  ): Promise<Response | undefined> {

    // Increment loop counter
    this.setState({
      ...this.state,
      status: 'perceiving',
      lastActivity: Date.now(),
      loopIteration: this.state.loopIteration + 1,
    })

    // Get last user message for memory priming
    const userMessages = this.messages.filter(m => m.role === 'user')
    const lastUserMessage = userMessages[userMessages.length - 1]
    // UIMessage uses .parts array (AI SDK v4+)
    let userText = ''
    if (lastUserMessage) {
      const parts = (lastUserMessage as any).parts ?? []
      const textParts = parts.filter((p: any) => p.type === 'text')
      userText = textParts.map((p: any) => p.text || '').join(' ')
      if (!userText) userText = (lastUserMessage as any).content || ''
    }

    // Build context-aware system prompt (perceive phase)
    const systemPrompt = await this.buildSystemPrompt(userText)
    const tools = this.buildTools()
    const modelMessages = await convertToModelMessages(this.messages)

    const resetState = () => {
      this.setState({
        ...this.state,
        status: 'idle',
        currentTool: undefined,
        lastActivity: Date.now(),
      })
    }

    // PRIMARY: Cloudflare Workers AI — llama-3.3-70b
    try {
      const workersai = createWorkersAI({ binding: this.env.AI })

      const result = streamText({
        model: workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
        system: systemPrompt,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(12),
        onFinish: async () => {
          resetState()
          // Post-turn: log session event
          await new Planner(this.env).logEvent('turn_complete', {
            loop_iteration: this.state.loopIteration,
            model: 'cloudflare/llama-3.3-70b',
          }).catch(() => {})
        },
      })

      return result.toUIMessageStreamResponse()

    } catch (cfErr) {
      console.error('[SuperAgent] CF Workers AI error:', cfErr)
    }

    // FALLBACK: Anthropic Claude Haiku
    if (this.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })

        const result = streamText({
          model: anthropic('claude-haiku-4-5-20251001'),
          system: systemPrompt,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(12),
          onFinish: async () => {
            resetState()
            await new Planner(this.env).logEvent('turn_complete', {
              loop_iteration: this.state.loopIteration,
              model: 'anthropic/claude-haiku',
            }).catch(() => {})
          },
        })

        return result.toUIMessageStreamResponse()

      } catch (antErr) {
        console.error('[SuperAgent] Anthropic fallback error:', antErr)
      }
    }

    // Both models failed — return error response
    resetState()
    return new Response(
      JSON.stringify({ error: 'All AI models unavailable. Check Cloudflare Workers AI binding and ANTHROPIC_API_KEY secret.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
