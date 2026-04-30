/**
 * ExtractionPipeline — auto-extracts reusable patterns from completed tasks.
 *
 * After a task completes successfully, analyzes the result for:
 *   - User preferences mentioned
 *   - Technical patterns discovered
 *   - Project-specific knowledge
 *
 * Extracted insights are stored in MemoryStore with tag "auto-extracted".
 * Rate-limited: max 1 extraction per task, debounced by 5 seconds.
 */

import { createLogger } from "../util/logger.js";
import type { MemoryStore } from "../memory/MemoryStore.js";

const log = createLogger("learning.extraction");

// ── Extraction patterns ───────────────────────────────────────────

interface ExtractionRule {
  /** Human-readable label for this rule. */
  readonly label: string;
  /** Regex to detect the pattern in task output. */
  readonly pattern: RegExp;
  /** Tags to apply to extracted memory entries. */
  readonly tags: readonly string[];
  /** Extract the insight text from regex match groups. */
  readonly extract: (match: RegExpMatchArray, fullText: string) => string | null;
}

const RULES: readonly ExtractionRule[] = [
  {
    label: "user-preference",
    pattern: /(?:prefer|always use|never use|like|want|don't want)\s+(.{5,120})/gi,
    tags: ["auto-extracted", "preference"],
    extract: (_match, _fullText) => {
      const captured = _match[1]?.trim();
      if (!captured || captured.length < 5) return null;
      return `User preference: ${captured}`;
    },
  },
  {
    label: "project-convention",
    pattern: /(?:we use|project uses|codebase uses|convention is|standard is)\s+(.{5,120})/gi,
    tags: ["auto-extracted", "convention"],
    extract: (_match, _fullText) => {
      const captured = _match[1]?.trim();
      if (!captured || captured.length < 5) return null;
      return `Project convention: ${captured}`;
    },
  },
  {
    label: "technical-pattern",
    pattern: /(?:pattern|approach|technique|workaround|solution):\s*(.{10,200})/gi,
    tags: ["auto-extracted", "pattern"],
    extract: (_match, _fullText) => {
      const captured = _match[1]?.trim();
      if (!captured || captured.length < 10) return null;
      return `Technical pattern: ${captured}`;
    },
  },
  {
    label: "important-fact",
    pattern: /(?:remember|note|important|key point|takeaway):\s*(.{5,200})/gi,
    tags: ["auto-extracted", "fact"],
    extract: (_match, _fullText) => {
      const captured = _match[1]?.trim();
      if (!captured || captured.length < 5) return null;
      return `Important: ${captured}`;
    },
  },
  {
    label: "tool-usage",
    pattern: /(?:use|run|execute|call)\s+`([^`]+)`\s+(?:to|for)\s+(.{5,100})/gi,
    tags: ["auto-extracted", "tool-usage"],
    extract: (_match, _fullText) => {
      const cmd = _match[1]?.trim();
      const purpose = _match[2]?.trim();
      if (!cmd || !purpose) return null;
      return `Tool usage: \`${cmd}\` — ${purpose}`;
    },
  },
];

// ── Deduplication ─────────────────────────────────────────────────

/**
 * Normalize text for dedup comparison — lowercase, collapse whitespace,
 * strip punctuation. Two insights that normalize to the same string
 * are considered duplicates.
 */
function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Pipeline ──────────────────────────────────────────────────────

export class ExtractionPipeline {
  private readonly memory: MemoryStore;

  /** Track which tasks we've already processed (prevent double-extract). */
  private readonly processed = new Set<string>();

  /** Debounce timers keyed by taskId. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  /** Debounce delay in ms. */
  private readonly debounceMs: number;

  constructor(memory: MemoryStore, opts?: { debounceMs?: number }) {
    this.memory = memory;
    this.debounceMs = opts?.debounceMs ?? 5000;
  }

  /**
   * Schedule extraction for a completed task. Debounced — calling
   * multiple times for the same taskId within the debounce window
   * collapses into a single extraction.
   */
  schedule(taskId: string, taskOutput: string): void {
    if (this.processed.has(taskId)) {
      log.debug({ taskId }, "extraction already processed, skipping");
      return;
    }

    // Clear existing timer if re-scheduled
    const existing = this.pending.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(taskId);
      this.runExtraction(taskId, taskOutput);
    }, this.debounceMs);

    this.pending.set(taskId, timer);
    log.debug({ taskId }, "extraction scheduled");
  }

  /**
   * Run extraction immediately (bypasses debounce). Useful for testing
   * or explicit "extract now" triggers.
   */
  extractNow(taskId: string, taskOutput: string): readonly string[] {
    // Clear any pending timer
    const existing = this.pending.get(taskId);
    if (existing) {
      clearTimeout(existing);
      this.pending.delete(taskId);
    }

    return this.runExtraction(taskId, taskOutput);
  }

  /**
   * Cancel a pending extraction.
   */
  cancel(taskId: string): boolean {
    const timer = this.pending.get(taskId);
    if (!timer) return false;
    clearTimeout(timer);
    this.pending.delete(taskId);
    log.debug({ taskId }, "extraction cancelled");
    return true;
  }

  /**
   * Cancel all pending extractions and clear processed set.
   */
  reset(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.processed.clear();
    log.debug("extraction pipeline reset");
  }

  // ── Internals ─────────────────────────────────────────────────

  private runExtraction(taskId: string, taskOutput: string): readonly string[] {
    if (this.processed.has(taskId)) return [];
    this.processed.add(taskId);

    const insights = this.extractInsights(taskOutput);
    if (insights.length === 0) {
      log.debug({ taskId }, "no insights extracted");
      return [];
    }

    // Deduplicate against existing memories
    const existing = this.memory.search("auto-extracted", { limit: 100, tagsAny: ["auto-extracted"] });
    const existingNorms = new Set(existing.map((e) => normalizeForDedup(e.content)));

    const savedIds: string[] = [];

    for (const insight of insights) {
      const norm = normalizeForDedup(insight.content);
      if (existingNorms.has(norm)) {
        log.debug({ content: insight.content }, "duplicate insight, skipping");
        continue;
      }
      existingNorms.add(norm);

      try {
        const entry = this.memory.save({
          content: insight.content,
          tags: [...insight.tags, `task:${taskId}`],
          source: "auto-extraction",
        });
        savedIds.push(entry.id);
        log.debug({ id: entry.id, rule: insight.rule }, "insight saved");
      } catch (err) {
        log.error({ err, content: insight.content }, "failed to save insight");
      }
    }

    log.info({ taskId, extracted: insights.length, saved: savedIds.length }, "extraction complete");
    return savedIds;
  }

  private extractInsights(text: string): Array<{
    content: string;
    tags: string[];
    rule: string;
  }> {
    const results: Array<{ content: string; tags: string[]; rule: string }> = [];
    const seenNorms = new Set<string>();

    for (const rule of RULES) {
      // Reset regex lastIndex for global patterns
      rule.pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(text)) !== null) {
        const content = rule.extract(match, text);
        if (!content) continue;

        const norm = normalizeForDedup(content);
        if (seenNorms.has(norm)) continue;
        seenNorms.add(norm);

        results.push({
          content,
          tags: [...rule.tags],
          rule: rule.label,
        });

        // Cap per-rule extractions to avoid noise
        if (results.filter((r) => r.rule === rule.label).length >= 3) break;
      }
    }

    return results;
  }
}
