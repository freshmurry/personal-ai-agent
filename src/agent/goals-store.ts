// src/agent/goals-store.ts

export type Goal = {
  id: string;
  description: string;
  status: string;
};

export async function loadActiveGoals(env: any): Promise<Goal[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM goals WHERE status='active'`
  ).all();
  return results;
}

export async function createGoal(env: any, description: string): Promise<Goal> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO goals (id, description, status, created)
     VALUES (?, ?, 'active', ?)`
  ).bind(id, description, Date.now()).run();
  return { id, description, status: 'active' };
}
