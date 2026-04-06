// src/agent/memory-manager.ts
// Tiered memory system — Base44 style
// Short-term:  Durable Object state (in-context, volatile)
// Long-term:   D1 structured + Vectorize semantic recall
// Memory is ALWAYS queried before planning and updated after execution.

import type { Bindings } from '../bindings'

export interface MemoryEntry {
  key: string
  val: string
  type: 'fact' | 'preference' | 'goal' | 'profile' | 'project' | 'system'
  freq: number
  ts: number
  last_access: number
}

export interface SemanticMemoryResult {
  text: string
  file: string
  score: number
  source: 'vectorize'
}

export interface MemoryContext {
  structured: MemoryEntry[]     // from D1 — exact match facts
  semantic: SemanticMemoryResult[]  // from Vectorize — similar concepts
  summary: string               // compressed context string for LLM injection
}

export class MemoryManager {
  constructor(private env: Bindings) {}

  // ── Store ─────────────────────────────────────────────────────────────────────
  async store(
    key: string,
    value: string,
    type: MemoryEntry['type'] = 'fact'
  ): Promise<{ key: string; stored: boolean }> {
    const k = key.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60)
    const v = value.slice(0, 4000)

    await this.env.DB.prepare(
      `INSERT INTO memory (key, val, type, freq, ts, last_access)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         val = excluded.val,
         type = excluded.type,
         freq = freq + 1,
         ts = excluded.ts,
         last_access = excluded.last_access`
    ).bind(k, v, type, Date.now(), Date.now()).run()

    // Also embed into Vectorize for semantic recall
    try {
      const embedding = await this.env.AI.run(
        '@cf/baai/bge-base-en-v1.5',
        { text: `${k}: ${v}` }
      ) as { data: number[][] }
      const vec = embedding.data[0]
      if (vec?.length) {
        await this.env.VECTORIZE.upsert([{
          id: `mem-${k}`,
          values: vec,
          metadata: { key: k, text: `${k}: ${v}`.slice(0, 500), type, source: 'memory' },
        }])
      }
    } catch (e) {
      console.warn('[MemoryManager] Vectorize embed failed for memory key:', k, e)
    }

    return { key: k, stored: true }
  }

  // ── Retrieve (structured + semantic) ─────────────────────────────────────────
  async retrieve(query: string, topK = 8): Promise<MemoryContext> {
    // 1. Structured retrieval from D1
    const { results: structured } = await this.env.DB.prepare(
      `SELECT key, val, type, freq, ts, last_access
       FROM memory
       WHERE (key LIKE ? OR val LIKE ?) AND key NOT LIKE '___%'
       ORDER BY freq DESC, ts DESC
       LIMIT 15`
    ).bind(`%${query}%`, `%${query}%`).all<MemoryEntry>()

    // Update access timestamps for retrieved items
    if (structured.length) {
      const keys = structured.map(m => `'${m.key}'`).join(',')
      await this.env.DB.prepare(
        `UPDATE memory SET last_access = ?, freq = freq + 1 WHERE key IN (${keys})`
      ).bind(Date.now()).run()
    }

    // 2. Semantic retrieval from Vectorize
    let semantic: SemanticMemoryResult[] = []
    try {
      const embedding = await this.env.AI.run(
        '@cf/baai/bge-base-en-v1.5',
        { text: query }
      ) as { data: number[][] }
      const vec = embedding.data[0]
      if (vec?.length) {
        const vResults = await this.env.VECTORIZE.query(vec, {
          topK,
          returnMetadata: 'all',
        })
        semantic = vResults.matches
          .filter(m => m.score > 0.35)
          .map(m => ({
            text: String((m.metadata as any)?.text || ''),
            file: String((m.metadata as any)?.file || (m.metadata as any)?.key || ''),
            score: m.score,
            source: 'vectorize' as const,
          }))
      }
    } catch (e) {
      console.warn('[MemoryManager] Vectorize query failed:', e)
    }

    // 3. Build compressed context summary
    const summary = this.buildSummary(structured, semantic, query)

    return { structured, semantic, summary }
  }

  // ── Get all memories (for UI listing) ────────────────────────────────────────
  async getAll(limit = 100): Promise<MemoryEntry[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT key, val, type, freq, ts, last_access
       FROM memory
       WHERE key NOT LIKE '___%'
       ORDER BY freq DESC, ts DESC
       LIMIT ?`
    ).bind(limit).all<MemoryEntry>()
    return results
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  async delete(key: string): Promise<void> {
    await this.env.DB.prepare(`DELETE FROM memory WHERE key = ?`).bind(key).run()
    // Best-effort remove from Vectorize
    try { await this.env.VECTORIZE.deleteByIds([`mem-${key}`]) } catch {}
  }

  // ── Self-audit: detect stale/redundant memories ───────────────────────────────
  async selfAudit(): Promise<{
    total: number
    stale_count: number
    high_freq_count: number
    recommendations: string[]
  }> {
    const { results } = await this.env.DB.prepare(
      `SELECT key, val, type, freq, ts, last_access FROM memory WHERE key NOT LIKE '___%'`
    ).all<MemoryEntry>()

    const now = Date.now()
    const staleThreshold = 30 * 24 * 60 * 60 * 1000 // 30 days
    const stale = results.filter(m => now - m.last_access > staleThreshold)
    const highFreq = results.filter(m => m.freq > 10)

    const recs: string[] = []
    if (stale.length > 10) recs.push(`${stale.length} memories not accessed in 30+ days — consider pruning`)
    if (results.length > 200) recs.push('Memory store is large (200+ entries) — consider archiving old project data')
    if (highFreq.length > 0) recs.push(`${highFreq.length} frequently accessed memories — these are core context`)

    return {
      total: results.length,
      stale_count: stale.length,
      high_freq_count: highFreq.length,
      recommendations: recs,
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────────
  private buildSummary(
    structured: MemoryEntry[],
    semantic: SemanticMemoryResult[],
    query: string
  ): string {
    const parts: string[] = []

    if (structured.length) {
      const facts = structured
        .slice(0, 8)
        .map(m => `${m.key}: ${m.val.slice(0, 120)}`)
        .join('\n')
      parts.push(`MEMORY FACTS:\n${facts}`)
    }

    if (semantic.length) {
      const docs = semantic
        .slice(0, 4)
        .map(m => `[${m.file}] ${m.text.slice(0, 200)}`)
        .join('\n')
      parts.push(`KNOWLEDGE BASE:\n${docs}`)
    }

    return parts.join('\n\n')
  }
}
