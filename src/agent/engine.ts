// src/agent/engine.ts
import type { Bindings } from '../bindings'

export class SuperAgent {
  constructor(private env: Bindings) {}

  async run(query: string): Promise<string> {
    try {
      const result = await this.env.AI.run(
        '@cf/meta/llama-3.1-8b-instruct',
        {
          messages: [{ role: 'user', content: query }],
        }
      )

      // Defensive normalization
      if (typeof result?.response === 'string') {
        return result.response
      }

      return 'I’m not sure how to respond to that.'
    } catch (err) {
      console.error('[SuperAgent]', err)

      // Fail soft — never crash the request
      return 'I ran into an internal issue while thinking. Please try again.'
    }
  }
}