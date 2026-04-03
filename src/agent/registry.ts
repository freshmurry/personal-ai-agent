// src/agent/registry.ts

import { BrowserTool } from '../tools/browser';
import { GitHubTool } from '../tools/github';
import { TwitterTool } from '../tools/twitter';
import { CalendarTool } from '../tools/calendar';

export function registerAgentTools(agent: any, env: any) {
  const browser = new BrowserTool(env);
  const github = new GitHubTool(env);
  const twitter = new TwitterTool(env);
  const calendar = new CalendarTool(env);

  agent.addTool({
    name: 'web_search',
    description: 'Search the internet',
    risk: 'low',
    schema: { query: 'string' },
    handler: ({ query }) => browser.searchWeb(query),
  });

  agent.addTool({
    name: 'github_propose_change',
    description: 'Create GitHub PRs',
    risk: 'high',
    schema: {},
    handler: (i) => github.proposeChange(i),
  });

  agent.addTool({
    name: 'twitter_post',
    description: 'Post tweet (approval + confidence gated)',
    risk: 'high',
    schema: { text: 'string', confidence: 'number', approvalId: 'string?' },
    handler: (i) => twitter.postTweet(i.text, i.confidence, i.approvalId),
  });

  agent.addTool({
    name: 'calendar_schedule_meeting',
    description: 'Schedule meeting (DST/approval aware)',
    risk: 'medium',
    schema: {},
    handler: (i) => calendar.scheduleMeeting(i),
  });
}
