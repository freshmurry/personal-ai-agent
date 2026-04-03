export class SessionDO {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/session') {
      if (request.method === 'GET') return Response.json(await this.state.storage.get('session') || {});
      if (request.method === 'POST') {
        await this.state.storage.put('session', await request.json());
        await this.state.storage.setAlarm(Date.now() + 30 * 60 * 1000);
        return Response.json({ ok: true });
      }
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    await this.state.storage.delete('session');
  }
}


export class AgentDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(): Promise<Response> {
    return new Response('AgentDO active');
  }
}
