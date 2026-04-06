export type Bindings = {
  DB: D1Database
  FILES: R2Bucket
  CACHE: KVNamespace
  OAUTH_STATES: KVNamespace
  AI: Ai
  VECTORIZE: VectorizeIndex
  SUPER_AGENT: DurableObjectNamespace
  AUTOMATION_WORKFLOW: Workflow
  TASK_QUEUE: Queue
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY?: string
  BRAVE_API_KEY?: string
  GITHUB_ACCESS_TOKEN?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SELF_CODING_ENABLED?: string
  ENVIRONMENT: 'development' | 'production'
  WORKER_URL: string
}
