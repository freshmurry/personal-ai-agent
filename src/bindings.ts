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

  // Cloudflare Browser Rendering
  BROWSER: Fetcher

  // Durable Objects & Workflows
  SUPER_AGENT: DurableObjectNamespace
  AUTOMATION_WORKFLOW: Workflow
  TASK_QUEUE: Queue<unknown>

  // API Keys / Secrets
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY?: string
  GITHUB_ACCESS_TOKEN?: string

  // OAuth App Credentials
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  LINKEDIN_CLIENT_ID?: string
  LINKEDIN_CLIENT_SECRET?: string

  // Vars
  ENVIRONMENT: 'development' | 'production'
  WORKER_URL: string
}
