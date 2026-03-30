import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

interface Params {
  trigger: string;
  instructions?: string;
  notify?: string;
  payload?: any;
}

export class AutomationWorkflow extends WorkflowEntrypoint<{ DB: D1Database, ANTHROPIC_API_KEY: string }, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { trigger, instructions, payload } = event.payload;

    // 1. AI Execution Step
    const aiResponse = await step.do('ai-logic', {
      retries: { limit: 2, delay: '10 seconds' }
    }, async () => {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-latest',
          max_tokens: 1000,
          messages: [{ role: 'user', content: `Trigger: ${trigger}\nContext: ${JSON.stringify(payload)}\nTask: ${instructions}` }],
        }),
      });
      return await resp.json();
    });

    // 2. Persist Result to D1 History
    await step.do('update-db', async () => {
      const content = (aiResponse as any).content?.[0]?.text || "No response";
      await this.env.DB.prepare(
        "INSERT INTO conversations (role, content, ts) VALUES (?, ?, ?)"
      ).bind('assistant', `[Workflow ${trigger}] ${content}`, Date.now()).run();
    });

    return { status: 'completed' };
  }
}
