// src/bindings.ts

export type Bindings = {
  DB: D1Database
  FILES: R2Bucket
  CACHE: KVNamespace
  AI: any
  VECTORIZE: VectorizeIndex

  SESSION: DurableObjectNamespace
  AGENT: DurableObjectNamespace

  AUTOMATION_WORKFLOW: Workflow

  ENVIRONMENT: 'development' | 'production'
}