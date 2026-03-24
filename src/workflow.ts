import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

interface Params {
  trigger: string;
  cron?: string;
  instructions?: string;
  notify?: string;
  payload?: Record<string, unknown>;
}

export class AutomationWorkflow extends WorkflowEntrypoint<{}, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { trigger, instructions, notify } = event.payload;

    const logged = await step.do('log-trigger', async () => ({
      triggered_at: new Date().toISOString(),
      trigger,
    }));

    const result = await step.do('execute', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, async () => {
      if (!instructions) return { skipped: true };
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': (this.env as any).ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: `Execute this automation and summarize what was done:\n\n${instructions}` }],
        }),
      });
      const d = await resp.json() as any;
      return { result: d.content?.[0]?.text || 'Completed' };
    });

    const notified = await step.do('notify', async () => {
      console.log(`[Workflow] notify=${notify}, result=${(result as any).result}`);
      return { notified: notify };
    });

    return { success: true, trigger, logged, result, notified, completed_at: new Date().toISOString() };
  }
}
