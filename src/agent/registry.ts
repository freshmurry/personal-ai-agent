// src/agent/registry.ts

import { BrowserTool } from '../tools/browser';
import { GitHubTool } from '../tools/github';
import { TwitterTool } from '../tools/twitter';
import { CalendarTool } from '../tools/calendar';

type WebSearchInput = {
  query: string;
};

type GitHubChangeInput = {
  repo: string;
  branch: string;
  title: string;
  description: string;
  files: Array<{
    path: string;
    content: string;
  }>;
};

type TwitterPostInput = {
  text: string;
  confidence: number;
  approvalId?: string;
};

type CalendarScheduleInput = {
  title: string;
  start: string;
  end: string;
  timezone: string;
  attendees?: string[];
  description?: string;
  confidence?: number;
  provider?: 'google' | 'outlook';
  approvalId?: string;
};

export function registerAgentTools(agent: any, env: any) {
  const browser = new BrowserTool(env);
  const github = new GitHubTool(env);
  const twitter = new TwitterTool(env);
  const calendar = new CalendarTool(env);

  // 🌐 Web search
  agent.addTool({
    name: 'web_search',
    description: 'Search the internet',
    risk: 'low',
    schema: { query: 'string' },
    handler: async (input: WebSearchInput) => {
      return browser.searchWeb(input.query);
    },
  });

  // 🧑‍💻 Self‑coding via GitHub PR
  agent.addTool({
    name: 'github_propose_change',
    description: 'Create GitHub pull requests',
    risk: 'high',
    schema: {},
    handler: async (input: GitHubChangeInput) => {
      return github.proposeChange(input);
    },
  });

  // 🐦 Twitter / X posting (approval + confidence gated)
  agent.addTool({
    name: 'twitter_post',
    description: 'Post a tweet (approval + confidence gated)',
    risk: 'high',
    schema: {
      text: 'string',
      confidence: 'number',
      approvalId: 'string?',
    },
    handler: async (input: TwitterPostInput) => {
      return twitter.postTweet(
        input.text,
        input.confidence,
        input.approvalId
      );
    },
  });

  // 📅 Calendar scheduling (DST + approval aware)
  agent.addTool({
    name: 'calendar_schedule_meeting',
    description: 'Schedule a meeting on a calendar',
    risk: 'medium',
    schema: {},
    handler: async (input: CalendarScheduleInput) => {
      return calendar.scheduleMeeting(input);
    },
  });
}
