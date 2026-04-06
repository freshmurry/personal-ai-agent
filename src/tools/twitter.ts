// src/tools/twitter.ts

export class TwitterTool {
  constructor(private env: any) {}

  async postTweet(text: string, confidence = 0, approvalId?: string) {
    if (confidence < 0.85) {
      throw new Error('Tweet blocked: confidence below threshold');
    }

    if (!approvalId) {
      const id = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO approvals (id, type, payload, status, created)
         VALUES (?, 'twitter', ?, 'pending', ?)`
      ).bind(id, JSON.stringify({ text }), Date.now()).run();

      return { approvalRequired: true, approvalId: id };
    }

    const { results } = await this.env.DB.prepare(
      `SELECT * FROM approvals WHERE id=? AND status='approved'`
    ).bind(approvalId).all();

    if (!results.length) throw new Error('Tweet approval not granted');

    const resp = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.TWITTER_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!resp.ok) throw new Error(await resp.text());
    return await resp.json();
  }
}