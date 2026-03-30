/**
 * Browser Rendering & Web Search Tool
 */

export class BrowserTool {
  constructor(private env: any) {}

  async searchWeb(query: string) {
    // For a simple $5 plan approach, use a Search API (Brave/Serper/Tavily)
    // Claude 3.5 is great at parsing these results.
    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    
    // Note: Requires a BRAVE_API_KEY in your secrets
    const resp = await fetch(searchUrl, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': this.env.BRAVE_API_KEY }
    });
    
    const data = await resp.json() as any;
    return data.web?.results?.slice(0, 3).map((r: any) => ({
      title: r.title,
      description: r.description,
      url: r.url
    }));
  }
}
