/**
 * CostTracker — per-task token cost tracking.
 *
 * Records input/output token counts per model invocation and computes
 * USD cost from a static price map. Unknown models estimate at $0 —
 * the record is still stored for token auditing.
 *
 * Table: cost_entries (one row per LLM call)
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("cost-tracker");

// ── Price map (USD per 1 M tokens) ────────────────────────────────
// Format: "provider:model" → { input, output } per million tokens.
// Kept inline — easy to update, no runtime dependency.

interface TokenPrice {
  readonly input: number;  // USD per 1M input tokens
  readonly output: number; // USD per 1M output tokens
}

const PRICE_MAP: Readonly<Record<string, TokenPrice>> = {
  // Anthropic
  "anthropic:claude-opus-4-0-20250514":        { input: 15.0,  output: 75.0  },
  "anthropic:claude-sonnet-4-20250514":      { input: 3.0,   output: 15.0  },
  "anthropic:claude-3-5-sonnet-20241022":    { input: 3.0,   output: 15.0  },
  "anthropic:claude-3-5-haiku-20241022":     { input: 0.8,   output: 4.0   },
  "anthropic:claude-3-haiku-20240307":       { input: 0.25,  output: 1.25  },
  // OpenAI
  "openai:gpt-4o":                           { input: 2.5,   output: 10.0  },
  "openai:gpt-4o-mini":                      { input: 0.15,  output: 0.6   },
  "openai:gpt-4-turbo":                      { input: 10.0,  output: 30.0  },
  "openai:o1":                               { input: 15.0,  output: 60.0  },
  "openai:o1-mini":                          { input: 3.0,   output: 12.0  },
  "openai:o3-mini":                          { input: 1.1,   output: 4.4   },
  // Google
  "google:gemini-2.0-flash":                 { input: 0.1,   output: 0.4   },
  "google:gemini-2.0-pro":                   { input: 1.25,  output: 10.0  },
  "google:gemini-1.5-pro":                   { input: 1.25,  output: 5.0   },
  "google:gemini-1.5-flash":                 { input: 0.075, output: 0.3   },
};

// ── Types ──────────────────────────────────────────────────────────

export interface CostEntry {
  readonly id: string;
  readonly taskId: string;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly createdAt: number;
}

export interface DailyBreakdown {
  readonly date: string;       // YYYY-MM-DD
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly calls: number;
}

export interface TaskCostSummary {
  readonly taskId: string;
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly calls: number;
  readonly entries: readonly CostEntry[];
}

// ── Raw DB row ─────────────────────────────────────────────────────

interface CostRow {
  id: string;
  task_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: number;
}

interface AggRow {
  date: string;
  total_cost: number;
  total_input: number;
  total_output: number;
  calls: number;
}

// ── Tracker ────────────────────────────────────────────────────────

export class CostTracker {
  private readonly stmts: ReturnType<CostTracker["prepareStatements"]>;

  constructor(private readonly db: Database.Database) {
    this.createTable();
    this.stmts = this.prepareStatements();
    log.debug("cost tracker initialized");
  }

  /**
   * Record a single LLM invocation's token usage.
   * Cost is auto-calculated from the static price map.
   */
  record(
    taskId: string,
    model: string,
    provider: string,
    inputTokens: number,
    outputTokens: number,
  ): CostEntry {
    const id = randomUUID();
    const now = Date.now();
    const costUsd = CostTracker.calculateCost(provider, model, inputTokens, outputTokens);

    this.stmts.insert.run(id, taskId, model, provider, inputTokens, outputTokens, costUsd, now);

    log.debug(
      { taskId, model, provider, inputTokens, outputTokens, costUsd },
      "cost recorded",
    );

    return { id, taskId, model, provider, inputTokens, outputTokens, costUsd, createdAt: now };
  }

  /**
   * Total cost in USD for today (UTC).
   */
  todayCost(): number {
    const startOfDay = todayStartEpoch();
    const row = this.stmts.sumSince.get(startOfDay) as { total: number | null } | undefined;
    return row?.total ?? 0;
  }

  /**
   * Per-day cost breakdown for the last N days (default 30).
   * Ordered most recent first.
   */
  dailyBreakdown(days = 30): readonly DailyBreakdown[] {
    const since = Date.now() - days * 24 * 60 * 60_000;
    const rows = this.stmts.dailyBreakdown.all(since) as AggRow[];
    return rows.map((r) => ({
      date: r.date,
      totalCostUsd: r.total_cost,
      totalInputTokens: r.total_input,
      totalOutputTokens: r.total_output,
      calls: r.calls,
    }));
  }

  /**
   * Full cost summary for a specific task.
   */
  taskCost(taskId: string): TaskCostSummary {
    const rows = this.stmts.byTask.all(taskId) as CostRow[];
    const entries = rows.map(rowToEntry);
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    for (const e of entries) {
      totalCost += e.costUsd;
      totalInput += e.inputTokens;
      totalOutput += e.outputTokens;
    }
    return {
      taskId,
      totalCostUsd: totalCost,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      calls: entries.length,
      entries,
    };
  }

  /**
   * Calculate cost for a provider:model pair. Public so callers can
   * preview cost without recording.
   */
  static calculateCost(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const key = `${provider}:${model}`;
    const price = PRICE_MAP[key];
    if (!price) return 0;
    const inputCost = (inputTokens / 1_000_000) * price.input;
    const outputCost = (outputTokens / 1_000_000) * price.output;
    // Round to 8 decimal places to avoid floating-point noise.
    return Math.round((inputCost + outputCost) * 1e8) / 1e8;
  }

  /**
   * Check if a model has pricing data.
   */
  static hasPricing(provider: string, model: string): boolean {
    return `${provider}:${model}` in PRICE_MAP;
  }

  // ── Internals ───────────────────────────────────────────────────

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_entries (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        model         TEXT NOT NULL,
        provider      TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd      REAL NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cost_task ON cost_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_entries(created_at);
    `);
  }

  private prepareStatements() {
    return {
      insert: this.db.prepare(
        `INSERT INTO cost_entries (id, task_id, model, provider, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      sumSince: this.db.prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_entries WHERE created_at >= ?",
      ),
      dailyBreakdown: this.db.prepare(
        `SELECT
           date(created_at / 1000, 'unixepoch') AS date,
           SUM(cost_usd)        AS total_cost,
           SUM(input_tokens)    AS total_input,
           SUM(output_tokens)   AS total_output,
           COUNT(*)             AS calls
         FROM cost_entries
         WHERE created_at >= ?
         GROUP BY date(created_at / 1000, 'unixepoch')
         ORDER BY date DESC`,
      ),
      byTask: this.db.prepare(
        "SELECT * FROM cost_entries WHERE task_id = ? ORDER BY created_at ASC",
      ),
    } as const;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function todayStartEpoch(): number {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return utcMidnight;
}

function rowToEntry(row: CostRow): CostEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    model: row.model,
    provider: row.provider,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  };
}
