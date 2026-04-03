// src/tools/github.ts
// SELF-CODING TOOL — GitHub PR CREATION (SAFE, GOVERNED)

export interface CodeChangeProposal {
  repo: string;              // "owner/repo"
  branch: string;            // e.g. "agent-autogen-123"
  title: string;
  description: string;       // rationale + risk summary
  files: Array<{
    path: string;
    content: string;         // full file content (overwrite-safe)
  }>;
}

export class GitHubTool {
  constructor(private env: any) {}

  private async api(path: string, opts: RequestInit = {}) {
    const resp = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this.env.GITHUB_ACCESS_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {})
      }
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`GitHub API error ${resp.status}: ${t}`);
    }
    return resp.json();
  }

  async createBranch(repo: string, base: string, branch: string) {
    const ref = await this.api(`/repos/${repo}/git/ref/heads/${base}`);
    await this.api(`/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha
      })
    });
  }

  async putFile(repo: string, branch: string, path: string, content: string) {
    // Check if file exists to get sha
    let sha: string | undefined;
    try {
      const existing = await this.api(
        `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`
      );
      sha = existing.sha;
    } catch {}

    await this.api(`/repos/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `agent: update ${path}`,
        content: btoa(unescape(encodeURIComponent(content))),
        branch,
        sha
      })
    });
  }

  async openPR(repo: string, base: string, head: string, title: string, body: string) {
    return this.api(`/repos/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body,
        base,
        head
      })
    });
  }

  // MAIN ENTRY — SAFE SELF-CODING
  async proposeChange(proposal: CodeChangeProposal) {
    // GOVERNORS (hard stop without approval flag)
    if (!this.env.SELF_CODING_ENABLED) {
      throw new Error('Self-coding disabled by governor');
    }

    // 1) Create branch from main
    await this.createBranch(proposal.repo, 'main', proposal.branch);

    // 2) Write files exactly as provided (no partial diffs)
    for (const f of proposal.files) {
      await this.putFile(proposal.repo, proposal.branch, f.path, f.content);
    }

    // 3) Open PR (human approval gate)
    const pr = await this.openPR(
      proposal.repo,
      'main',
      proposal.branch,
      proposal.title,
      proposal.description
    );

    // 4) Log proposal
    await this.env.DB.prepare(
      `INSERT INTO tool_runs (tool_name, input, output, ts)
       VALUES (?, ?, ?, ?)`
    ).bind(
      'github_propose_change',
      JSON.stringify(proposal),
      JSON.stringify({ pr_url: pr.html_url }),
      Date.now()
    ).run();

    return { pr_url: pr.html_url };
  }
}