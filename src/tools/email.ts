// src/tools/email.ts
import { Hono } from 'hono'

export const email = new Hono()

email.post('/', async (c) => {
  const { to, subject, html } = await c.req.json()

  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'agent@local.dev', name: 'SuperAgent' },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  })

  return c.json({ ok: true })
})