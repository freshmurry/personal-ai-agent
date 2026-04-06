// src/workflow.ts
// AutomationWorkflow — extends AgentWorkflow from agents/workflows
// Runs scheduled or triggered automation tasks with durable steps.

import { AgentWorkflow } from 'agents/workflows'
import type { Bindings } from './bindings'
import type { SuperAgent } from './agent/engine'
import { BrowserTool } from './tools/browser'

interface AutomationParams {
  trigger: 'cron' | 'manual' | 'entity'
  automation_id?: string
  instructions?: string
  notify?: string
  payload?: any
}

export class AutomationWorkflow extends AgentWorkflow<
  SuperAgent,
  AutomationParams,
  object,
  Bindings
> {
  async run(event: any, step: any) {
    const params: AutomationParams = event.payload ?? {}
    const env = this.env as Bindings

    await step.do('log_start', async () => {
      if (params.automation_id) {
        await env.DB.prepare(
          `UPDATE automations SET runs = runs + 1, last_run = ? WHERE id = ?`
        )
          .bind(Date.now(), params.automation_id)
          .run()
      }
      return { started: Date.now() }
    })

    const classification = await step.do('classify', async () => {
      const result: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [
          { role: 'system', content: 'Reply with only SIMPLE or COMPLEX.' },
          { role: 'user', content: params.instructions ?? '' },
        ],
      } as any)
      const text: string = result?.response ?? ''
      return { route: text.toUpperCase().includes('COMPLEX') ? 'COMPLEX' : 'SIMPLE' }
    })

    const result = await step.do('execute', async () => {
      if (classification.route === 'COMPLEX') {
        try {
          const browser = new BrowserTool(env)
          const searchResults = await browser.searchWeb(params.instructions ?? '')
          const context = Array.isArray(searchResults)
            ? searchResults.map((r: any) => `${r.title}: ${r.snippet}`).join('\n')
            : JSON.stringify(searchResults).slice(0, 2000)
          const aiResult: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
            messages: [
              {
                role: 'system',
                content: 'You are SuperAgent. Use the context to answer accurately.',
              },
              { role: 'user', content: `Context:\n${context}\n\nTask: ${params.instructions}` },
            ],
          } as any)
          return { response: aiResult?.response, route: 'COMPLEX' }
        } catch {
          // fallthrough to simple
        }
      }
      const aiResult: any = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
        messages: [
          { role: 'user', content: params.instructions ?? 'No instructions provided.' },
        ],
      } as any)
      return { response: aiResult?.response, route: 'SIMPLE' }
    })

    await step.do('log_result', async () => {
      await env.DB.prepare(
        `INSERT INTO conversations (role, content, ts, summary) VALUES ('assistant', ?, ?, 1)`
      )
        .bind(`[Automation] ${result.response}`, Date.now())
        .run()
      if (params.automation_id) {
        await env.DB.prepare(
          `UPDATE automations SET successes = successes + 1 WHERE id = ?`
        )
          .bind(params.automation_id)
          .run()
      }
      return { logged: true }
    })

    await step.reportComplete({ response: result.response })
    return result.response
  }
}
