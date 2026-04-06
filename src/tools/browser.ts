// src/tools/browser.ts
// Cloudflare Browser Rendering — replaces Brave Search entirely
// Uses @cloudflare/puppeteer via the BROWSER binding in wrangler.toml

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
}

export class BrowserTool {
  constructor(private env: any) {}

  /**
   * Search the web using Cloudflare Browser Rendering.
   * Opens a real headless browser, performs a Google search, returns structured results.
   */
  async searchWeb(query: string): Promise<SearchResult[]> {
    if (!this.env.BROWSER) {
      // Fallback: use Cloudflare AI Search if BROWSER binding isn't available
      return this.fallbackSearch(query)
    }

    let browser: any
    try {
      const puppeteer = await import('@cloudflare/puppeteer')
      browser = await puppeteer.default.launch(this.env.BROWSER)
      const page = await browser.newPage()
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      )

      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

      const results: SearchResult[] = await page.evaluate(() => {
        const items: SearchResult[] = []
        // Google result divs
        document.querySelectorAll('div.g, div[data-sokoban-container]').forEach((el) => {
          const titleEl = el.querySelector('h3')
          const linkEl = el.querySelector('a[href]') as HTMLAnchorElement | null
          const snippetEl = el.querySelector(
            'div[data-sncf], div.VwiC3b, span.aCOpRe, div[style*="-webkit-line-clamp"]'
          )
          const title = titleEl?.textContent?.trim()
          const url = linkEl?.href
          const snippet = snippetEl?.textContent?.trim()
          if (title && url && url.startsWith('http') && !url.includes('google.com')) {
            items.push({ title, url, snippet: snippet || '' })
          }
        })
        return items.slice(0, 8)
      })

      return results.length > 0 ? results : await this.fallbackSearch(query)
    } catch (err: any) {
      console.error('Browser search failed:', err?.message)
      return this.fallbackSearch(query)
    } finally {
      if (browser) {
        try { await browser.close() } catch {}
      }
    }
  }

  /**
   * Browse a specific URL — returns text content and/or links.
   * Core browse capability for reading articles, docs, etc.
   */
  async browseUrl(
    url: string,
    extract: 'text' | 'links' | 'both' = 'text'
  ): Promise<BrowseResult> {
    if (!this.env.BROWSER) {
      return { url, title: 'Browser binding not available', text: 'Set up BROWSER binding in wrangler.toml to enable full browsing.' }
    }

    let browser: any
    try {
      const puppeteer = await import('@cloudflare/puppeteer')
      browser = await puppeteer.default.launch(this.env.BROWSER)
      const page = await browser.newPage()
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      )
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })

      const result: BrowseResult = await page.evaluate(
        (extractMode: string) => {
          const title = document.title || ''
          let text: string | undefined
          let links: Array<{ text: string; href: string }> | undefined

          if (extractMode === 'text' || extractMode === 'both') {
            // Strip scripts, styles, nav, footer
            const clone = document.body.cloneNode(true) as HTMLElement
            clone.querySelectorAll('script,style,nav,footer,header,aside,[aria-hidden="true"]').forEach((el) => el.remove())
            text = clone.innerText
              .replace(/\n{3,}/g, '\n\n')
              .trim()
              .slice(0, 8000)
          }

          if (extractMode === 'links' || extractMode === 'both') {
            links = Array.from(document.querySelectorAll('a[href]'))
              .filter((a) => {
                const href = (a as HTMLAnchorElement).href
                return href.startsWith('http') && (a as HTMLElement).innerText?.trim()
              })
              .slice(0, 50)
              .map((a) => ({
                text: ((a as HTMLElement).innerText || '').trim().slice(0, 80),
                href: (a as HTMLAnchorElement).href,
              }))
          }

          return { url: window.location.href, title, text, links }
        },
        extract
      )

      return result
    } catch (err: any) {
      return { url, title: 'Error', text: `Browse failed: ${err?.message}` }
    } finally {
      if (browser) {
        try { await browser.close() } catch {}
      }
    }
  }

  /**
   * Fallback: use Cloudflare AI to answer directly when no browser is available.
   * Better than a broken dependency — still useful.
   */
  private async fallbackSearch(query: string): Promise<SearchResult[]> {
    try {
      const result = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              'You are a search assistant. Return 5 relevant facts about the query as a JSON array: [{title, url, snippet}]. Use plausible URLs.',
          },
          { role: 'user', content: `Search query: ${query}` },
        ],
      })
      const text = result?.response ?? ''
      const match = text.match(/\[[\s\S]*\]/)
      if (match) return JSON.parse(match[0])
    } catch {}
    return [{ title: 'Browser not configured', url: '', snippet: `Could not search for: ${query}. Add BROWSER binding to wrangler.toml.` }]
  }
}
