// src/agent/file-intelligence.ts
import type { Bindings } from '../bindings'

const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 100

function chunkText(text: string): string[] {
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    chunks.push(text.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return chunks
}

export class FileIntelligence {
  constructor(private env: Bindings) {}

  async processFile(key: string, buffer: ArrayBuffer): Promise<{ success: boolean; chunks: number } | { success: boolean; error: string }> {
    try {
      const text = new TextDecoder().decode(buffer)
      const chunks = chunkText(text)

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const embedding = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: chunk })
        const vec = (embedding as { data: number[][] }).data[0]
        await this.env.VECTORIZE.upsert([
          {
            id: `${key}-${i}`,
            values: vec,
            metadata: { file: key, chunk: i, text: chunk.slice(0, 500) },
          },
        ])
      }

      return { success: true, chunks: chunks.length }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
