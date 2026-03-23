export class AgentDO {
  private state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/memory') {
      if (request.method === 'GET') {
        const stored = await this.state.storage.get<any[]>('memory') || [];
        return Response.json(stored);
      }
      if (request.method === 'POST') {
        const body = await request.json() as any;
        const current = await this.state.storage.get<any[]>('memory') || [];
        if (body.action === 'set') {
          const idx = current.findIndex((m: any) => m.key === body.key);
          const entry = { key: body.key, val: body.val, type: body.type || 'fact', ts: Date.now(), freq: 1 };
          if (idx >= 0) { entry.freq = (current[idx].freq || 1) + 1; current[idx] = entry; }
          else current.push(entry);
          await this.state.storage.put('memory', current);
        } else if (body.action === 'clear') {
          await this.state.storage.put('memory', []);
        }
        return Response.json({ ok: true });
      }
    }
    return new Response('Not found', { status: 404 });
  }
}

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
