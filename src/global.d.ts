// src/global.d.ts
declare var fetch: typeof globalThis.fetch

interface D1Database {
  prepare(query: string): {
    bind(...values: any[]): {
      run(): Promise<any>
      all<T = any>(): Promise<{ results: T[] }>
    }
  }
}

interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void>
  get(key: string): Promise<any>
  delete(key: string): Promise<void>
}

interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

interface VectorizeIndex {}

interface DurableObjectNamespace {}

interface Workflow {
  create(input: any): Promise<void>
}