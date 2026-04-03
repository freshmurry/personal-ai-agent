// src/agent/engine.ts

// ==========================================
// 🧠 SUPERAGENT v2 — AUTONOMOUS ENGINE
// ==========================================

export interface AgentContext {
  userId: string;
  sessionId: string;
  query: string;
}

type AgentState = {
  goal: string;
  steps: any[];
  memory: any[];
  done: boolean;
};

type Tool = {
  name: string;
  description: string;
  schema: any;
  handler: (input: any) => Promise<any>;
};

export class SuperAgent {
  private tools: Record<string, Tool> = {};

  constructor(private env: any) {
    this.registerTools();
  }

  // ==========================================
  // 🚀 MAIN ENTRY (AGENT LOOP)
  // ==========================================
  async run(ctx: AgentContext) {
    const state: AgentState = {
      goal: ctx.query,
      steps: [],
      memory: await this.loadMemory(ctx.userId),
      done: false,
    };

    for (let i = 0; i < 6; i++) {
      const thought = await this.think(state);
      const action = await this.decide(thought);

      if (action.type === 'finish') {
        state.done = true;
        return action.output;
      }

      const result = await this.act(action);

      state.steps.push({ thought, action, result });
      await this.reflect(state);
    }

    return this.finalize(state);
  }

  // ==========================================
  // 🧠 THINK (LLM + VECTOR MEMORY)
  // ==========================================
  async think(state: AgentState) {
    const vectorContext = await this.vectorSearch(state.goal);

    const res = await this.env.AI.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      {
        messages: [
          {
            role: 'system',
            content:
              'You are an autonomous AI agent. Think step-by-step before acting.',
          },
          {
            role: 'system',
            content: `Relevant memory/context:\n${JSON.stringify(
              vectorContext,
            )}`,
          },
          {
            role: 'system',
            content: JSON.stringify(state),
          },
          {
            role: 'user',
            content: state.goal,
          },
        ],
      },
    );

    return res.response;
  }

  // ==========================================
  // 🎯 DECIDE
  // ==========================================
  async decide(thought: string) {
    const toolList = Object.values(this.tools).map((t) => ({
      name: t.name,
      description: t.description,
    }));

    const res = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: `Choose the next action.

Return JSON ONLY:
{
  "type": "tool" | "finish",
  "tool": "tool_name",
  "input": {},
  "output": "final answer if finished"
}`,
        },
        { role: 'system', content: JSON.stringify(toolList) },
        { role: 'user', content: thought },
      ],
    });

    try {
      return JSON.parse(res.response);
    } catch {
      return {
        type: 'finish',
        output: 'I could not determine a valid next action.',
      };
    }
  }

  // ==========================================
  // ⚙️ ACT
  // ==========================================
  async act(action: any) {
    if (action.type !== 'tool') return null;

    const tool = this.tools[action.tool];
    if (!tool) return { error: 'Unknown tool' };

    try {
      return await tool.handler(action.input);
    } catch (e) {
      return { error: String(e) };
    }
  }

  // ==========================================
  // 🔁 REFLECT
  // ==========================================
  async reflect(state: AgentState) {
    await this.env.DB.prepare(
      'INSERT INTO memory (user_id, key, val, ts) VALUES (?, ?, ?, ?)',
    )
      .bind(
        'system',
        'agent_step',
        JSON.stringify(state.steps.at(-1)),
        Date.now(),
      )
      .run();
  }

  // ==========================================
  // 🧠 FINALIZE
  // ==========================================
  async finalize(state: AgentState) {
    const res = await this.env.AI.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      {
        messages: [
          { role: 'system', content: 'Generate the final answer.' },
          { role: 'system', content: JSON.stringify(state.steps) },
          { role: 'user', content: state.goal },
        ],
      },
    );

    return res.response;
  }

  // ==========================================
  // 🧠 MEMORY
  // ==========================================
  async loadMemory(userId: string) {
    const { results } = await this.env.DB.prepare(
      'SELECT * FROM memory WHERE user_id = ? ORDER BY ts DESC LIMIT 10',
    )
      .bind(userId)
      .all();

    return results;
  }

  // ==========================================
  // 🧠 VECTOR SEARCH
  // ==========================================
  async vectorSearch(query: string) {
    const embedding = await this.env.AI.run(
      '@cf/baai/bge-base-en-v1.5',
      { text: [query] },
    );

    const results = await this.env.VECTORIZE.query(embedding.data[0], {
      topK: 5,
    });

    return results.matches || [];
  }

  // ==========================================
  // 🧰 TOOLS
  // ==========================================
  registerTools() {
    this.addTool({
      name: 'web_search',
      description: 'Search the internet',
      schema: { query: 'string' },
      handler: async ({ query }) => {
        return { result: `Search results for: ${query}` };
      },
    });

    this.addTool({
      name: 'generate_image',
      description: 'Create an image',
      schema: { prompt: 'string' },
      handler: async ({ prompt }) => {
        return await this.env.AI.run(
          '@cf/stabilityai/stable-diffusion-xl-base-1.0',
          { prompt },
        );
      },
    });

    this.addTool({
      name: 'search_files',
      description: 'Search uploaded files',
      schema: { query: 'string' },
      handler: async ({ query }) => {
        return await this.vectorSearch(query);
      },
    });

    this.addTool({
      name: 'memory_write',
      description: 'Store memory',
      schema: { key: 'string', value: 'string' },
      handler: async ({ key, value }) => {
        await this.env.DB.prepare(
          'INSERT INTO memory (key, val, ts) VALUES (?, ?, ?)',
        )
          .bind(key, value, Date.now())
          .run();

        return { success: true };
      },
    });
  }

  addTool(tool: Tool) {
    this.tools[tool.name] = tool;
  }
}