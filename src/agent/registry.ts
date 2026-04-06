// src/agent/registry.ts
// Tool registry — wires up all tool classes.
// NOTE: BrowserTool now uses Cloudflare Browser Rendering REST API (no puppeteer).

import { BrowserTool } from '../tools/browser'
import { GitHubTool } from '../tools/github'
import { CalendarTool } from '../tools/calendar'

type WebSearchInput = {
  query: string
}

type GitHubChangeInput = {
  repo: string
  branch: string
  title: string
  description: string
  files: Array<{ path: string; content: string }>
}

type CalendarScheduleInput = {
  title: string
  start: string
  end: string
  timezone: string
  attendees?: string[]
  description?: string
  confidence?: number
  provider?: 'google' | 'outlook'
  approvalId?: string
}

export function registerAgentTools(agent: any, env: any) {
  const browser = new BrowserTool(env)
  const github = new GitHubTool(env)
  const calendar = new CalendarTool(env)

  // 🌐 Web search via Cloudflare Browser Rendering
  agent.addTool({
    name: 'web_search',
    description: 'Search the internet using Cloudflare Browser Rendering',
    risk: 'low',
    schema: { query: 'string' },
    handler: async (input: WebSearchInput) => {
      return browser.searchWeb(input.query)
    },
  })

  // 🌐 Browse a specific URL
  agent.addTool({
    name: 'browse_url',
    description: 'Fetch and read the content of any web page',
    risk: 'low',
    schema: { url: 'string', extract: 'string?' },
    handler: async (input: { url: string; extract?: 'text' | 'links' | 'both' }) => {
      return browser.browseUrl(input.url, input.extract ?? 'text')
    },
  })

  // 🧑‍💻 Self-coding via GitHub PR
  agent.addTool({
    name: 'github_propose_change',
    description: 'Create GitHub pull requests for code changes',
    risk: 'high',
    schema: {},
    handler: async (input: GitHubChangeInput) => {
      return github.proposeChange(input)
    },
  })

  // 📅 Calendar scheduling
  agent.addTool({
    name: 'calendar_schedule_meeting',
    description: 'Schedule a meeting on Google Calendar or Outlook',
    risk: 'medium',
    schema: {},
    handler: async (input: CalendarScheduleInput) => {
      return calendar.scheduleMeeting(input)
    },
  })
}
