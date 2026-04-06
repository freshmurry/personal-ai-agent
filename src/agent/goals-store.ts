// src/agent/goals-store.ts
import type { Bindings } from '../bindings'

export interface Goal {
  id: string
  description: string
  status: string
  priority: number
  created: number
  last_updated: number
}

export async function loadActiveGoals(env: Bindings): Promise<Goal[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, description, status, priority, created, last_updated FROM goals WHERE status = 'active' ORDER BY priority DESC, created DESC LIMIT 20`
  ).all<Goal>()
  return results
}
