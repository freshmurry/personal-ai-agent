export type Goal = {
  id: string;
  description: string;
  status: 'active' | 'completed' | 'failed';
  created: number;
  last_updated?: number;
};

export async function loadActiveGoals(env) {
  return env.DB
    .prepare(`SELECT * FROM goals WHERE status = 'active'`)
    .all();
}

export async function createGoal(env, description: string): Promise<Goal> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO goals (id, description, status, created)
     VALUES (?, ?, 'active', ?)`
  ).bind(id, description, now).run();

  return { id, description, status: 'active', created: now };
}