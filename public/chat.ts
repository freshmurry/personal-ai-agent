// chat.ts
import { Hono } from 'hono';

type Bindings = {
  ANTHROPIC_API_KEY: string;
};

export const chat = new Hono<{ Bindings: Bindings }>();

chat.post('/', async (c) => {
  const body = await c.req.json();

  const model =
    body.model ?? 'claude-sonnet-4-20250514';

  const payload = {
    model,
    max_tokens: body.max_tokens ?? 1000,
    system: body.system,
    messages: body.messages,
    stream: !!body.stream,
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': c.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  // ---------- Streaming ----------
  if (body.stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    c.executionCtx.waitUntil((async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        await writer.write(text);
      }
      writer.close();
    })());

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // ---------- Non‑stream ----------
  const data = await res.json();
  return c.json(data);
});
``