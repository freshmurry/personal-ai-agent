// src/agent/engine.ts
import type { Bindings } from '../index'

type AgentRunArgs = {
  userId: string
  sessionId: string
  query: string
  onToken?: (token: string) => void
}

export class SuperAgent {
  private env: Bindings

  constructor(env: Bindings) {
    this.env = env
  }

  async run(args: AgentRunArgs): Promise<string> {
    try {
      return await this.think(args)
    } catch (err: any) {
      // ✅ HARD FAILOVER: never let upstream 504 kill the request
      console.error('[SuperAgent] primary model failed:', err?.message)

      return await this.fallback(args)
    }
  }

  private async think({
    query,
    onToken,
  }: AgentRunArgs): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)

    try {
      const result = await this.env.AI.run(
        '@cf/meta/llama-3.1-8b-instruct',
        {
          messages: [{ role: 'user', content: query }],
          stream: !!onToken,
        },
        { signal: controller.signal }
      )

      if (!onToken) return result.response

      let full = ''
      for await (const chunk of result) {
        if (chunk?.response) {
          const token = chunk.response
          full += token
          onToken(token)
        }
      }

      return full
    } finally {
      clearTimeout(timeout)
    }
  }

  private async fallback({
    query,
    onToken,
  }: AgentRunArgs): Promise<string> {
    const result = await this.env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [{ role: 'user', content: query }],
        stream: !!onToken,
      }
    )

    if (!onToken) return result.response

    let full = ''
    for await (const chunk of result) {
      if (chunk?.response) {
        const token = chunk.response
        full += token
        onToken(token)
      }
    }

    return full
  }
}