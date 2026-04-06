// src/workflow.ts
import type { ExecutionContext } from '@cloudflare/workers-types'
import type { Bindings } from './bindings'

import { Connectors } from './connectors'
import { BrowserTool } from './tools/browser'

interface Params {
  trigger: string
  instructions?: string
  payload?: any
  notify?: string
  persona?: string
}

/**
 * Cloudflare Workflow
 * Discovered by Wrangler via exported class + run() method
 */
export class AutomationWorkflow {
  async run(
    params: Params,
    env: Bindings,
    ctx: ExecutionContext
  ): Promise<string> {
    const { trigger, instructions, persona } = params
    const now = new Date().toLocaleString()

    // Step 1: initial status
    await env.DB.prepare(
      "INSERT INTO conversations (role, content, ts, summary) VALUES ('system', 'Thinking...', ?, 1)"
    )
      .bind(Date.now())
      .run()

    // Step 2: simple router
    const classifier = await env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          { role: 'system', content: 'SIMPLE or COMPLEX' },
          { role: 'user', content: instructions ?? '' },
        ],
      }
    )

    const route = classifier.response.toUpperCase().includes('COMPLEX')
      ? 'COMPLEX'
      : 'SIMPLE'

    // SIMPLE path
    if (route === 'SIMPLE') {
      const result = await env.AI.run(
        '@cf/meta/llama-3.1-8b-instruct',
        {
          messages: [{ role: 'user', content: instructions ?? '' }],
        }
      )

      await env.DB.prepare(
        "INSERT INTO conversations (role, content, ts) VALUES ('assistant', ?, ?)"
      )
        .bind(result.response, Date.now())
        .run()

      return result.response
    }

    // COMPLEX placeholder
    const connectors = new Connectors(env)
    const browser = new BrowserTool(env)

    await env.DB.prepare(
      "UPDATE conversations SET content = 'Finished' WHERE summary = 1"
    )
      .bind()
      .run()

    return 'Done'
  }
}
