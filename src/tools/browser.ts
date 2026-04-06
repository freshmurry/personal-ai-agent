// src/tools/browser.ts
// Cloudflare Browser Rendering — uses the native REST API via the BROWSER binding.
// NO puppeteer. NO @cloudflare/puppeteer. Just fetch() through env.BROWSER.

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface BrowseResult {
  url: string
  title: string
  text?: string
  links?: Array<{ text: string; href: string }>
  error?: string
}

export class BrowserTool {
  constructor(private env: any) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Public: Search the web
  // Uses Cloudflare Browser Rendering to load Google search results page
  // Falls back to Cloudflare Workers AI if BROWSER binding isn't available.
  // ─────────────────────────────────────────────────────────────────────────────
  async searchWeb(query: string): Promise<SearchResult[]> {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`

    const html = await this.fetchHtml(searchUrl)
    if (!html) return this.fallbackSearch(query)

    const results = parseGoogleResults(html)
    return results.length > 0 ? results : this.fallbackSearch(query)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public: Browse a URL — returns text content and/or links
  // ─────────────────────────────────────────────────────────────────────────────
  async browseUrl(
    url: string,
    extract: 'text' | 'links' | 'both' = 'text'
  ): Promise<BrowseResult> {
    const html = await this.fetchHtml(url)
    if (!html) {
      return { url, title: 'Error', error: 'Failed to fetch page — BROWSER binding may not be configured.' }
    }

    const title = extractTitle(html)
    const result: BrowseResult = { url, title }

    if (extract === 'text' || extract === 'both') {
      result.text = extractText(html)
    }
    if (extract === 'links' || extract === 'both') {
      result.links = extractLinks(html, url)
    }

    return result
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core: fetch HTML via Cloudflare Browser Rendering REST API
  // The BROWSER binding is a Fetcher that proxies to the Browser Rendering service.
  // Docs: https://developers.cloudflare.com/browser-rendering/rest-api/
  // ─────────────────────────────────────────────────────────────────────────────
  private async fetchHtml(url: string): Promise<string | null> {
    // BROWSER binding is a Fetcher — we call its fetch() with the Browser Rendering API endpoint
    if (!this.env.BROWSER) {
      console.warn('[BrowserTool] BROWSER binding not available — falling back')
      return null
    }

    try {
      const response = await this.env.BROWSER.fetch('https://browser.cloudflare.com/v1/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          screenshotOptions: { omit: true },        // no screenshot needed
          addScriptTag: [],
          waitUntil: 'domcontentloaded',
          gotoOptions: { timeout: 20000 },
        }),
      })

      if (!response.ok) {
        console.error(`[BrowserTool] Browser Rendering API error ${response.status}`)
        return null
      }

      const data: any = await response.json()
      // The REST API returns { html: string, ... }
      return data?.html ?? null
    } catch (err: any) {
      console.error('[BrowserTool] fetchHtml failed:', err?.message)
      return null
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Fallback: ask Workers AI directly if browser isn't available
  // ─────────────────────────────────────────────────────────────────────────────
  private async fallbackSearch(query: string): Promise<SearchResult[]> {
    try {
      const result: any = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              'You are a search assistant. Return exactly 5 relevant results as a JSON array with this shape: [{title: string, url: string, snippet: string}]. No markdown, just JSON.',
          },
          { role: 'user', content: `Search query: ${query}` },
        ],
      })
      const text: string = result?.response ?? ''
      const match = text.match(/\[[\s\S]*?\]/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed)) return parsed.slice(0, 5)
      }
    } catch (err: any) {
      console.error('[BrowserTool] fallbackSearch failed:', err?.message)
    }
    return [
      {
        title: 'Search unavailable',
        url: '',
        snippet: `Could not search for "${query}". Ensure the BROWSER binding is configured in wrangler.toml.`,
      },
    ]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML parsing helpers — pure regex/string ops, no DOM, no browser dependency
// These run in the Worker runtime, not in the browser.
// ─────────────────────────────────────────────────────────────────────────────

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return m ? m[1].trim() : ''
}

function extractText(html: string): string {
  return html
    // Remove scripts, styles, nav, footer
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    // Replace block tags with newlines
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|section|article)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8000)
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = []
  const pattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  const base = (() => {
    try { return new URL(baseUrl).origin } catch { return '' }
  })()

  while ((match = pattern.exec(html)) !== null && links.length < 50) {
    const href = match[1].trim()
    const rawText = match[2].replace(/<[^>]+>/g, '').trim().slice(0, 80)
    if (!href || !rawText) continue
    const fullHref = href.startsWith('http') ? href : href.startsWith('/') ? base + href : href
    if (fullHref.startsWith('http')) {
      links.push({ text: rawText, href: fullHref })
    }
  }
  return links
}

function parseGoogleResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // Extract <h3> blocks with surrounding link context
  const blockPattern = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi
  let m: RegExpExecArray | null

  while ((m = blockPattern.exec(html)) !== null && results.length < 8) {
    const url = m[1]
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    if (!url || !title || url.includes('google.com')) continue
    results.push({ title, url, snippet: '' })
  }

  // If no h3-based results, try simpler cite/url extraction
  if (results.length === 0) {
    const citePattern = /<cite[^>]*>(https?:\/\/[^<]+)<\/cite>/gi
    while ((m = citePattern.exec(html)) !== null && results.length < 8) {
      const url = m[1].trim()
      if (url && !url.includes('google.com')) {
        results.push({ title: url, url, snippet: '' })
      }
    }
  }

  return results
}
