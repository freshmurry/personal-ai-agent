// src/agent/engine.ts
// ==========================================
// 🧠 SUPERAGENT v2 — AUTONOMOUS ENGINE (STABLE, CONSISTENT)
// ==========================================

import { BrowserTool } from '../../tools/browser';
import { GitHubTool } from '../../tools/github';

export interface AgentContext {
  userId: string;
  sessionId: string;
  query: string;
  goalId?: string;
}

type Goal = {
  id: string;
  description: string;
  status: string;
  created: number;
  last_updated?: number;
};

type PlanStep = {
  id: string;
  step_no: number;
  action: string;
  status: string;
};

type Tool = {
  name: string;
  description: string;
  schema: any;
  risk: 'low' | 'medium' | 'high';
  handler: (input: any) => Promise<any>;
};

type GovernanceState = {
  actionsTaken: number;
  maxActions: number;
  confidenceFloor: number;
};

export class SuperAgent {
  private tools: Record<string, Tool> = {};
  private governors: GovernanceState = {
    actionsTaken: 0,
    maxActions: 50,
    confidenceFloor: 0.85,
  };

  constructor(private env: any) {
    this.registerTools();
  }

  // ==========================================
  // 🚀 MAIN AUTONOMOUS LOOP
  // ==========================================
  async run(ctx: AgentContext) {
    const goal = ctx.goalId
      ? await this.loadGoal(ctx.goalId)
      : await this.createGoal(ctx.query);

    const plan = await this.loadOrCreatePlan(goal);

    for (const step of plan) {
      if (step.status === 'done') continue;

      if (this.governors.actionsTaken >= this.governors.maxActions) {
        return 'Governor halted execution (max actions reached)';
      }

      const thought = await this.think(goal, plan);
      const decision = await this.decide(thought, step);

      if (decision.type === 'finish') {
        await this.completeGoal(goal, decision.output);
        await this.reflectOnGoal(goal, plan);
        return decision.output;
      }

      const result = await this.act(decision);
      await this.recordToolRun(decision, result);
      await this.markPlanStep(step, result);
    }

    return 'Goal execution paused';
  }

  // ==========================================
  // 🧠 THINK (MEMORY + VECTOR + TIME AWARE)
  // ==========================================
  async think(goal: Goal, plan: PlanStep[]) {
    const memory = await this.loadMemory();
    const vectorContext = await this.vectorSearch(goal.description);
    const now = new Date().toISOString();

    const res = await this.env.AI.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      {
        messages: [
          { role: 'system', content: 'You are an autonomous, cautious AI agent.' },
          { role: 'system', content: `Current time: ${now}` },
          { role: 'system', content: `Relevant memory: ${JSON.stringify(memory)}` },
          { role: 'system', content: `Relevant knowledge: ${JSON.stringify(vectorContext)}` },
          { role: 'system', content: `Current plan: ${JSON.stringify(plan)}` },
          { role: 'user', content: goal.description },
        ],
      }
    );

    return res.response;
  }

  // ==========================================
  // 🎯 DECIDE (WITH CONFIDENCE GOVERNOR)
  // ==========================================
  async decide(thought: string, step: PlanStep) {
    const toolList = Object.values(this.tools).map(t => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
    }));

    const res = await this.env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          {
            role: 'system',
            content: `Current step: ${step.action}
Return JSON:
{
  "type": "tool" | "finish",
  "tool": "string | null",
  "input": {},
  "output": "string | null",
  "confidence": number
}`,
          },
          { role: 'system', content: JSON.stringify(toolList) },
          { role: 'user', content: thought },
        ],
      }
    );

    const decision = JSON.parse(res.response);
    const confidence = decision.confidence ?? 0;

    if (confidence < this.governors.confidenceFloor) {
      return {
        type: 'finish',
        output: 'Decision confidence below safety threshold.',
      };
    }

    return decision;
  }

  // ==========================================
  // ⚙️ ACT (WITH RISK GOVERNORS)
  // ==========================================
  async act(action: any) {
    if (action.type !== 'tool') return null;

    const tool = this.tools[action.tool];
    if (!tool) throw new Error('Unknown tool');

    if (tool.risk === 'high' && !this.env.ALLOW_HIGH_RISK_ACTIONS) {
      throw new Error('High-risk action blocked by governor');
    }

    this.governors.actionsTaken++;
    return tool.handler(action.input);
  }

  // ==========================================
  // 🧠 MEMORY
  // ==========================================
  async loadMemory() {
    const { results } = await this.env.DB.prepare(
      'SELECT * FROM memory ORDER BY ts DESC LIMIT 10'
    ).all();
    return results;
  }

  // ==========================================
  // 🔍 VECTOR SEARCH
  // ==========================================
  async vectorSearch(query: string) {
    const embedding = await this.env.AI.run(
      '@cf/baai/bge-base-en-v1.5',
      { text: [query] }
    );

    const results = await this.env.VECTORIZE.query(
      embedding.data[0],
      { topK: 5 }
    );

    return results.matches || [];
  }

  // ==========================================
  // 🧭 GOALS / PLANS
  // ==========================================
  async createGoal(description: string): Promise<Goal> {
    const id = crypto.randomUUID();
    const now = Date.now();

    await this.env.DB.prepare(
      `INSERT INTO goals (id, description, status, created)
       VALUES (?, ?, 'active', ?)`
    ).bind(id, description, now).run();

    return { id, description, status: 'active', created: now };
  }

  async loadGoal(id: string): Promise<Goal> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM goals WHERE id=?`
    ).bind(id).all();

    if (!results.length) throw new Error('Goal not found');
    return results[0];
  }

  async loadOrCreatePlan(goal: Goal): Promise<PlanStep[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM plans WHERE goal_id=? ORDER BY step_no`
    ).bind(goal.id).all();

    if (results.length) return results;

    const resp = await this.env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [{ role: 'user', content: `Break into steps:\n${goal.description}` }],
      }
    );

    const steps = resp.response.split('\n').filter(Boolean);
    for (let i = 0; i < steps.length; i++) {
      await this.env.DB.prepare(
        `INSERT INTO plans (id, goal_id, step_no, action, status, created)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).bind(
        crypto.randomUUID(),
        goal.id,
        i,
        steps[i],
        Date.now()
      ).run();
    }

    return this.loadOrCreatePlan(goal);
  }

  async markPlanStep(step: PlanStep, result: any) {
    await this.env.DB.prepare(
      `UPDATE plans SET status='done', result=?, updated=? WHERE id=?`
    ).bind(JSON.stringify(result), Date.now(), step.id).run();
  }

  async completeGoal(goal: Goal, output: string) {
    await this.env.DB.prepare(
      `UPDATE goals SET status='completed', completed=? WHERE id=?`
    ).bind(Date.now(), goal.id).run();

    await this.env.DB.prepare(
      `INSERT INTO conversations (role, content, ts)
       VALUES ('assistant', ?, ?)`
    ).bind(output, Date.now()).run();
  }

  async reflectOnGoal(goal: Goal, plan: PlanStep[]) {
    const reflection = await this.env.AI.run(
      '@cf/meta/llama-3.3-70b-instruct',
      {
        messages: [
          { role: 'system', content: 'Reflect on what worked and what did not.' },
          { role: 'user', content: JSON.stringify({ goal, plan }) },
        ],
      }
    );

    await this.env.DB.prepare(
      `INSERT INTO reflections (context, insight, ts)
       VALUES (?, ?, ?)`
    ).bind(goal.description, reflection.response, Date.now()).run();
  }

  // ==========================================
  // 🧰 TOOL REGISTRY (INLINE, STABLE)
  // ==========================================
  registerTools() {
    const browser = new BrowserTool(this.env);
    const github = new GitHubTool(this.env);

    this.addTool({
      name: 'web_search',
      description: 'Search the internet',
      schema: { query: 'string' },
      risk: 'low',
      handler: async ({ query }) => browser.searchWeb(query),
    });

    this.addTool({
      name: 'memory_write',
      description: 'Persist memory',
      schema: { key: 'string', value: 'string' },
      risk: 'low',
      handler: async ({ key, value }) => {
        await this.env.DB.prepare(
          'INSERT INTO memory (key, val, ts) VALUES (?, ?, ?)'
        ).bind(key, value, Date.now()).run();
        return { success: true };
      },
    });

    this.addTool({
      name: 'github_propose_change',
      description: 'Propose code changes via GitHub PR',
      schema: {
        repo: 'string',
        branch: 'string',
        title: 'string',
        description: 'string',
        files: 'array',
      },
      risk: 'high',
      handler: async (input) => github.proposeChange(input),
    });
  }

  addTool(tool: Tool) {
    this.tools[tool.name] = tool;
  }

  async recordToolRun(action: any, result: any) {
    await this.env.DB.prepare(
      `INSERT INTO tool_runs (tool_name, input, output, ts)
       VALUES (?, ?, ?, ?)`
    ).bind(
      action.tool,
      JSON.stringify(action.input),
      JSON.stringify(result),
      Date.now()
    ).run();
  }
}