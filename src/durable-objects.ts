// src/durable-objects.ts
import type { DurableObjectState } from '@cloudflare/workers-types'
import type { Bindings } from './index'

export class SessionDO {
  constructor(
    private state: DurableObjectState,
    private env: Bindings
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/session') {
      if (request.method === 'GET') {
        return Response.json(
          (await this.state.storage.get('session')) || {}
        )
      }

      if (request.method === 'POST') {
        await this.state.storage.put('session', await request.json())
        await this.state.storage.setAlarm(Date.now() + 30 * 60 * 1000)
        return Response.json({ ok: true })
      }
    }

    return new Response('Not found', { status: 404 })
  }

  async alarm() {
    await this.state.storage.delete('session')
  }
}

export class AgentDO {
  constructor(
    private state: DurableObjectState,
    private env: Bindings
  ) {}

  async fetch(): Promise<Response> {
    return new Response('AgentDO active')
  }
}