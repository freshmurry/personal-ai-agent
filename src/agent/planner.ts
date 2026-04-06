// src/agent/planner.ts
// Base44-style structured planner — all reasoning is explicit and inspectable.
// Produces JSON plans. Zero hidden chain-of-thought. All steps are auditable.

import type { Bindings } from '../bindings'

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlanStepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

export interface PlanStep {
  tool: string
  input: Record<string, unknown>
  rationale?: string
  status: PlanStepStatus
  result?: unknown
  error?: string
  duration_ms?: number
}

export interface StructuredPlan {
  id: string
  goal: string
  goal_id?: string
  assumptions: string[]
  steps: PlanStep[]
  success_criteria: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  current_step: number
  reflection?: string
  created: number
  completed?: number
}

// ── Allowed tools (governance allowlist) ─────────────────────────────────────
export const ALLOWED_TOOLS = new Set([
  // Memory
  'store_memory',
  'retrieve_memory',
  // Planning
  'create_plan',
  'update_plan',
  // Execution
  'run_task',
  'call_api',
  // Knowledge
  'vector_search',
  'document_lookup',
  // System
  'log_event',
  'self_audit',
  // Extended
  'web_search',
  'browse_url',
  'github_push_file',
  'read_github_file',
  'send_gmail',
  'create_calendar_event',
  'post_linkedin',
  'index_file',
  'update_identity',
])

// Tools that require human approval before execution
export const APPROVAL_REQUIRED_TOOLS = new Set([
  'send_gmail',
  'post_linkedin',
  'call_api',
])

// ── Plan parser ───────────────────────────────────────────────────────────────
// Extracts structured plan from LLM output (looks for JSON block)
export function extractPlanFromText(text: string): Partial<StructuredPlan> | null {
  // Try to find a JSON block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
                    text.match(/\{[\s\S]*"goal"[\s\S]*"steps"[\s\S]*\}/)

  let raw = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : null
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (!parsed.goal || !Array.isArray(parsed.steps)) return null

    // Validate each step has a tool field
    const steps: PlanStep[] = parsed.steps
      .filter((s: any) => typeof s.tool === 'string' && ALLOWED_TOOLS.has(s.tool))
      .map((s: any) => ({
        tool: s.tool,
        input: s.input || {},
        rationale: s.rationale || '',
        status: 'pending' as PlanStepStatus,
      }))

    return {
      goal: parsed.goal,
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      steps,
      success_criteria: parsed.success_criteria || 'Task completed successfully.',
    }
  } catch {
    return null
  }
}

// ── Planner class ─────────────────────────────────────────────────────────────
export class Planner {
  constructor(private env: Bindings) {}

  // Create a new plan from structured data and persist to D1
  async createPlan(plan: Partial<StructuredPlan> & { goal: string; steps: PlanStep[] }): Promise<StructuredPlan> {
    const id = crypto.randomUUID()
    const full: StructuredPlan = {
      id,
      goal: plan.goal,
      goal_id: plan.goal_id,
      assumptions: plan.assumptions || [],
      steps: plan.steps,
      success_criteria: plan.success_criteria || 'Task completed.',
      status: 'pending',
      current_step: 0,
      created: Date.now(),
    }

    await this.env.DB.prepare(
      `INSERT INTO plans (id, goal_id, goal, assumptions, steps, success_criteria, status, current_step, created)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
    ).bind(
      id,
      plan.goal_id || null,
      plan.goal,
      JSON.stringify(full.assumptions),
      JSON.stringify(full.steps),
      full.success_criteria,
      full.created
    ).run()

    await this.logEvent('plan_created', { plan_id: id, goal: plan.goal, step_count: plan.steps.length })
    return full
  }

  // Load a plan from D1
  async loadPlan(planId: string): Promise<StructuredPlan | null> {
    const row = await this.env.DB.prepare(
      `SELECT * FROM plans WHERE id = ?`
    ).bind(planId).first<Record<string, unknown>>()

    if (!row) return null
    return this.rowToPlan(row)
  }

  // Update a step's status and result
  async updateStep(
    planId: string,
    stepIndex: number,
    status: PlanStepStatus,
    result?: unknown,
    error?: string
  ): Promise<void> {
    const plan = await this.loadPlan(planId)
    if (!plan) return

    plan.steps[stepIndex] = {
      ...plan.steps[stepIndex],
      status,
      result,
      error,
    }

    const nextStep = status === 'success' || status === 'skipped'
      ? stepIndex + 1
      : stepIndex

    const allDone = plan.steps.every(s => s.status === 'success' || s.status === 'skipped')
    const hasFailed = plan.steps.some(s => s.status === 'error')
    const planStatus = hasFailed ? 'failed' : (allDone ? 'completed' : 'running')

    await this.env.DB.prepare(
      `UPDATE plans SET steps = ?, current_step = ?, status = ?, completed = ?
       WHERE id = ?`
    ).bind(
      JSON.stringify(plan.steps),
      nextStep,
      planStatus,
      (planStatus === 'completed' || planStatus === 'failed') ? Date.now() : null,
      planId
    ).run()
  }

  // Attach reflection after plan completes
  async addReflection(planId: string, reflection: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE plans SET reflection = ? WHERE id = ?`
    ).bind(reflection, planId).run()
    await this.logEvent('plan_reflected', { plan_id: planId, reflection: reflection.slice(0, 200) })
  }

  // Get recent plan history
  async getRecentPlans(limit = 10): Promise<StructuredPlan[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM plans ORDER BY created DESC LIMIT ?`
    ).bind(limit).all<Record<string, unknown>>()
    return results.map(r => this.rowToPlan(r))
  }

  // Performance: count successful vs failed plan steps
  async getPerformanceStats(): Promise<{
    total_plans: number
    completed_plans: number
    failed_plans: number
    success_rate: number
    most_used_tools: Array<{ tool: string; count: number }>
  }> {
    const countRow = await this.env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
       FROM plans`
    ).first<{ total: number; completed: number; failed: number }>()

    const toolRows = await this.env.DB.prepare(
      `SELECT tool_name, COUNT(*) as cnt FROM tool_log GROUP BY tool_name ORDER BY cnt DESC LIMIT 10`
    ).all<{ tool_name: string; cnt: number }>()

    const total = countRow?.total || 0
    const completed = countRow?.completed || 0
    const failed = countRow?.failed || 0

    return {
      total_plans: total,
      completed_plans: completed,
      failed_plans: failed,
      success_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      most_used_tools: (toolRows.results || []).map(r => ({ tool: r.tool_name, count: r.cnt })),
    }
  }

  // Log an agent event
  async logEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO agent_events (id, type, payload, ts) VALUES (?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), type, JSON.stringify(payload), Date.now()).run()
  }

  // Log a tool call
  async logToolCall(
    planId: string | null,
    toolName: string,
    input: unknown,
    output: unknown,
    status: 'success' | 'error',
    durationMs: number,
    error?: string
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO tool_log (id, plan_id, tool_name, input, output, status, duration_ms, error, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      planId || null,
      toolName,
      JSON.stringify(input),
      JSON.stringify(output),
      status,
      durationMs,
      error || null,
      Date.now()
    ).run()
  }

  private rowToPlan(row: Record<string, unknown>): StructuredPlan {
    return {
      id: String(row.id),
      goal: String(row.goal),
      goal_id: row.goal_id ? String(row.goal_id) : undefined,
      assumptions: JSON.parse(String(row.assumptions || '[]')),
      steps: JSON.parse(String(row.steps || '[]')),
      success_criteria: String(row.success_criteria || ''),
      status: String(row.status || 'pending') as StructuredPlan['status'],
      current_step: Number(row.current_step || 0),
      reflection: row.reflection ? String(row.reflection) : undefined,
      created: Number(row.created),
      completed: row.completed ? Number(row.completed) : undefined,
    }
  }
}
