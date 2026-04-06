// src/bindings.ts
export type Bindings = {
  // Data
  DB: D1Database
  FILES: R2Bucket
  CACHE: KVNamespace
  OAUTH_STATES: KVNamespace

  // AI & Search
  AI: Ai
  VECTORIZE: VectorizeIndex

  // Cloudflare Browser Rendering — native REST API, no puppeteer
  // Declared as `Fetcher` (service binding type from workers-types)
  BROWSER: Fetcher

  // Durable Objects & Workflows
  SUPER_AGENT: DurableObjectNamespace
  AUTOMATION_WORKFLOW: Workflow
  TASK_QUEUE: Queue<unknown>

  // Secrets
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY?: string
  GITHUB_ACCESS_TOKEN?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SELF_CODING_ENABLED?: string

  // Vars
  ENVIRONMENT: 'development' | 'production'
  WORKER_URL: string
}
