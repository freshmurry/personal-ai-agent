/**
 * Browser Rendering & Web Search Tool
 */

export class BrowserTool {
  constructor(private env: any) {}

  async searchWeb(query: string) {
    if (!this.env.BRAVE_API_KEY) {
      throw new Error('BRAVE_API_KEY is not set');
    }

    const searchUrl =
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;

    const resp = await fetch(searchUrl, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.env.BRAVE_API_KEY,
      },
    });

    if (!resp.ok) {
      throw new Error(`Brave search failed: ${resp.status}`);
    }

    const data: any = await resp.json();

    return (
      data.web?.results?.slice(0, 3).map((r: any) => ({
        title: r.title,
        description: r.description,
        url: r.url,
      })) ?? []
    );
  }
}