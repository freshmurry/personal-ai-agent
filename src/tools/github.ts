// src/tools/github.ts
import type { Bindings } from '../bindings'

interface ProposeChangeInput {
  repo: string
  branch: string
  title: string
  description: string
  files: Array<{ path: string; content: string }>
}

export class GitHubTool {
  constructor(private env: Bindings) {}

  async proposeChange(input: ProposeChangeInput): Promise<{ pr_url?: string; error?: string }> {
    const token = this.env.GITHUB_ACCESS_TOKEN
    if (!token) return { error: 'GITHUB_ACCESS_TOKEN not configured' }

    const [owner, repo] = input.repo.split('/')
    const base = 'HEAD'
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    }

    try {
      // Get default branch SHA
      const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`, { headers })
      const refData = await refRes.json() as { object?: { sha: string } }
      const sha = refData?.object?.sha
      if (!sha) return { error: 'Could not get repo HEAD SHA' }

      // Create branch
      await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha }),
      })

      // Commit each file
      for (const file of input.files) {
        const encoded = btoa(unescape(encodeURIComponent(file.content)))
        // Check if file exists for SHA
        let fileSha: string | undefined
        try {
          const existing = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file.path}?ref=${input.branch}`, { headers })
          if (existing.ok) {
            const d = await existing.json() as { sha?: string }
            fileSha = d?.sha
          }
        } catch { /* new file */ }

        const body: Record<string, string> = {
          message: `chore: update ${file.path}`,
          content: encoded,
          branch: input.branch,
        }
        if (fileSha) body.sha = fileSha

        await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file.path}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body),
        })
      }

      // Create PR
      const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: input.title,
          body: input.description,
          head: input.branch,
          base: 'main',
        }),
      })
      const pr = await prRes.json() as { html_url?: string }
      return { pr_url: pr?.html_url }
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
}
