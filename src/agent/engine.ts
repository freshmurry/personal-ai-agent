// src/agent/engine.ts
import type { Bindings } from '../index'

type AgentRunArgs = {
  userId: string
  sessionId: string
  query: string
  onToken?: (token: string) => void
}


export class SuperAgent {
  constructor(private env: Bindings) {}

  async run(query: string): Promise<string> {
    const result = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: query }],
    })
    return result.response
  }
}