/**
 * SmartRecall — enhanced recall combining FTS5 BM25 + recency + frequency.
 *
 * Standard MemoryStore.search() returns raw BM25-ranked results. SmartRecall
 * re-ranks by blending three signals:
 *   1. BM25 relevance (from FTS5)
 *   2. Recency boost (newer entries score higher)
 *   3. Frequency boost (often-recalled entries score higher)
 *
 * Also tracks access counts in a separate table so frequently-recalled
 * entries rise in future queries.
 *
 * Table: recall_stats(memory_id TEXT PK, access_count INT, last_accessed INT)
 */

import { createLogger } from "../util/logger.js";
import type Database from "better-sqlite3";
import type { MemoryStore, MemoryHit } from "../memory/MemoryStore.js";

const log = createLogger("learning.recall");

// ── Config ────────────────────────────────────────────────────────

/** How fast recency boost decays. 1.0 = 7-day half-life. */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60_000;

/** Max frequency boost (caps so one viral entry doesn't dominate). */
const MAX_FREQUENCY_BOOST = 2.0;

/** Weight blending: [bm25, recency, frequency]. Must sum to 1. */
const WEIGHTS = { bm25: 0.5, recency: 0.3, frequency: 0.2 } as const;

// ── Schema ────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recall_stats (
  memory_id     TEXT PRIMARY KEY,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER NOT NULL
);
`;

// ── Types ─────────────────────────────────────────────────────────

export interface SmartRecallHit {
  readonly id: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Raw BM25 rank from FTS5 (lower = more relevant). */
  readonly bm25Rank: number;
  /** Combined score (higher = better). */
  readonly score: number;
  /** How many times this entry has been recalled. */
  readonly accessCount: number;
}

interface StatsRow {
  memory_id: string;
  access_count: number;
  last_accessed: number;
}

// ── SmartRecall ───────────────────────────────────────────────────

export class SmartRecall {
  private readonly stmts: ReturnType<SmartRecall["prepareStatements"]>;

  constructor(
    private readonly db: Database.Database,
    private readonly memory: MemoryStore,
  ) {
    db.exec(SCHEMA);
    this.stmts = this.prepareStatements();
    log.debug("smart recall initialized");
  }

  /**
   * Recall memories matching `query`, re-ranked by relevance + recency + frequency.
   *
   * Fetches more candidates from FTS5 than `limit` to allow re-ranking,
   * then returns the top `limit` after blending signals.
   */
  recall(query: string, limit = 10): readonly SmartRecallHit[] {
    if (!query.trim()) return [];

    // Fetch 3x candidates to give re-ranking room
    const candidateLimit = Math.min(limit * 3, 100);
    const raw = this.memory.search(query, { limit: candidateLimit });

    if (raw.length === 0) return [];

    const now = Date.now();

    // Load frequency stats for all candidates in one pass
    const statsMap = this.loadStatsForIds(raw.map((r) => r.id));

    // Normalize BM25 ranks to [0, 1] where 1 = best
    const bm25Scores = normalizeBm25(raw);

    // Score and rank
    const scored: SmartRecallHit[] = raw.map((hit, i) => {
      const bm25Score = bm25Scores[i]!;
      const recencyScore = computeRecency(hit.createdAt, now);
      const stats = statsMap.get(hit.id);
      const accessCount = stats?.access_count ?? 0;
      const frequencyScore = computeFrequency(accessCount);

      const score =
        WEIGHTS.bm25 * bm25Score +
        WEIGHTS.recency * recencyScore +
        WEIGHTS.frequency * frequencyScore;

      return {
        id: hit.id,
        content: hit.content,
        tags: hit.tags,
        source: hit.source,
        createdAt: hit.createdAt,
        updatedAt: hit.updatedAt,
        bm25Rank: hit.rank,
        score,
        accessCount,
      };
    });

    // Sort by score descending, take top `limit`
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);

    // Track access for returned results
    this.recordAccess(results.map((r) => r.id), now);

    log.debug(
      { query, candidates: raw.length, returned: results.length },
      "smart recall complete",
    );

    return results;
  }

  /**
   * Get access stats for a specific memory entry.
   */
  getStats(memoryId: string): { accessCount: number; lastAccessed: number } | null {
    const row = this.stmts.getStats.get(memoryId) as StatsRow | undefined;
    if (!row) return null;
    return { accessCount: row.access_count, lastAccessed: row.last_accessed };
  }

  /**
   * Reset access stats for a memory entry (e.g. after content update).
   */
  resetStats(memoryId: string): void {
    this.stmts.deleteStats.run(memoryId);
  }

  // ── Internals ─────────────────────────────────────────────────

  private loadStatsForIds(ids: readonly string[]): Map<string, StatsRow> {
    const map = new Map<string, StatsRow>();
    // SQLite doesn't support array binds — batch in chunks
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT memory_id, access_count, last_accessed FROM recall_stats WHERE memory_id IN (${placeholders})`)
        .all(...chunk) as StatsRow[];
      for (const row of rows) {
        map.set(row.memory_id, row);
      }
    }
    return map;
  }

  private recordAccess(ids: readonly string[], now: number): void {
    const upsert = this.stmts.upsertStats;
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        upsert.run(id, now);
      }
    });
    tx();
  }

  private prepareStatements() {
    return {
      upsertStats: this.db.prepare(
        `INSERT INTO recall_stats (memory_id, access_count, last_accessed)
         VALUES (?, 1, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           access_count = access_count + 1,
           last_accessed = excluded.last_accessed`,
      ),
      getStats: this.db.prepare(
        `SELECT memory_id, access_count, last_accessed FROM recall_stats WHERE memory_id = ?`,
      ),
      deleteStats: this.db.prepare(
        `DELETE FROM recall_stats WHERE memory_id = ?`,
      ),
    } as const;
  }
}

// ── Scoring helpers ───────────────────────────────────────────────

/**
 * Normalize BM25 ranks to [0, 1]. FTS5 BM25 is negative (more negative
 * = more relevant). We invert and scale so the best match gets 1.0.
 */
function normalizeBm25(hits: readonly MemoryHit[]): number[] {
  if (hits.length === 0) return [];
  if (hits.length === 1) return [1.0];

  const ranks = hits.map((h) => h.rank);
  const min = Math.min(...ranks); // most relevant (most negative)
  const max = Math.max(...ranks); // least relevant
  const range = max - min;

  if (range === 0) return hits.map(() => 1.0);

  // Invert: min rank → 1.0, max rank → 0.0
  return ranks.map((r) => 1.0 - (r - min) / range);
}

/**
 * Recency score: exponential decay with configurable half-life.
 * Returns [0, 1] where 1 = just created.
 */
function computeRecency(createdAt: number, now: number): number {
  const ageMs = Math.max(0, now - createdAt);
  return Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
}

/**
 * Frequency score: log-scaled access count, capped at MAX_FREQUENCY_BOOST.
 * Returns [0, 1] normalized.
 */
function computeFrequency(accessCount: number): number {
  if (accessCount <= 0) return 0;
  const raw = Math.log2(1 + accessCount);
  return Math.min(raw / MAX_FREQUENCY_BOOST, 1.0);
}
