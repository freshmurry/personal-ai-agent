// src/workflow.ts
import { Workflow } from '@cloudflare/workers-types'
import type { ExecutionContext } from '@cloudflare/workers-types'
import type { Bindings } from './index'

import { Connectors } from './connectors'
import { BrowserTool } from './tools/browser'

interface Params {
  trigger: string
  instructions?: string
  payload?: any
  notify?: string
  persona?: string
}

export class AutomationWorkflow extends Workflow<Params> {
  async run(
    params: Params,
    env: Bindings,
    ctx: ExecutionContext
  ): Promise<string> {
    const { trigger, instructions, persona } = params
    const now = new Date().toLocaleString()

    /* ─────────── STEP 1: Initial UX status ─────────── */
    await env.DB.prepare(
      "INSERT INTO conversations (role, content, ts, summary) VALUES ('system', 'Thinking...', ?, 1)"
    )
      .bind(Date.now())
      .run()

    /* ─────────── STEP 2: ROUTER ─────────── */
    const classifier = await env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          { role: 'system', content: 'SIMPLE or COMPLEX' },
          { role: 'user', content: instructions ?? '' },
        ],
      }
    )

    const route = classifier.response
      .toUpperCase()
      .includes('COMPLEX')
      ? 'COMPLEX'
      : 'SIMPLE'

    /* ─────────── SIMPLE PATH ─────────── */
    if (route === 'SIMPLE') {
      const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'user', content: instructions ?? '' }],
      })

      await env.DB.prepare(
        "INSERT INTO conversations (role, content, ts) VALUES ('assistant', ?, ?)"
      )
        .bind(result.response, Date.now())
        .run()

      return result.response
    }

    /* ─────────── COMPLEX PATH ─────────── */
    const connectors = new Connectors(env)
    const browser = new BrowserTool(env)

    // (Example placeholder for real work)
    await env.DB.prepare(
      "UPDATE conversations SET content = 'Finished' WHERE summary = 1"
    )
      .bind()
      .run()

    return 'Done'
  }
}