/**
 * DeclarativeMemoryStore — hermes-pattern two-file declarative memory.
 *
 *   data/memory/MEMORY.md   — your notes about the environment / project
 *   data/memory/USER.md     — facts about the user
 *
 * Why two files, not one table:
 *   - Human-editable. The user can open MEMORY.md and read it, fix it.
 *   - Declarative format (one fact per entry, §-separated) discourages
 *     task/TODO pollution.
 *   - Char-bounded per target (USER: 1375, MEMORY: 2200). Full files
 *     force the agent to prioritise what really matters — old items get
 *     replaced rather than appended.
 *   - Frozen snapshot at load() → mid-session writes DO touch disk but
 *     the system-prompt copy doesn't change. Preserves the prefix cache
 *     across an entire session.
 *
 * API mirrors hermes: add / replace / remove × target ∈ {memory, user}.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { scanContent } from "../skills/SecurityScanner.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("memory.declarative");

const ENTRY_DELIMITER = "\n§\n";

export type MemoryTarget = "memory" | "user";

export const CHAR_LIMITS: Readonly<Record<MemoryTarget, number>> = {
  memory: 2200,
  user: 1375,
};

export const FILENAMES: Readonly<Record<MemoryTarget, string>> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

export interface MemoryWriteResult {
  readonly success: boolean;
  readonly message: string;
  readonly entryCount?: number;
  readonly chars?: number;
  readonly limit?: number;
}

export class DeclarativeMemoryStore {
  private entries: Record<MemoryTarget, string[]> = { memory: [], user: [] };
  private snapshot: Record<MemoryTarget, string> = { memory: "", user: "" };

  constructor(private readonly memoryDir: string) {}

  /**
   * Load from disk and capture a frozen system-prompt snapshot.
   * Must be called before `formatForSystemPrompt`.
   */
  async load(): Promise<void> {
    if (!existsSync(this.memoryDir)) mkdirSync(this.memoryDir, { recursive: true });
    for (const target of ["memory", "user"] as const) {
      this.entries[target] = await this.readFileEntries(target);
      this.snapshot[target] = this.renderBlock(target, this.entries[target]);
    }
    log.info({
      memoryEntries: this.entries.memory.length,
      userEntries: this.entries.user.length,
    }, "declarative memory loaded");
  }

  /** Frozen system-prompt block. Empty string if the target is empty. */
  formatForSystemPrompt(target: MemoryTarget): string {
    return this.snapshot[target];
  }

  async add(target: MemoryTarget, content: string): Promise<MemoryWriteResult> {
    const trimmed = content.trim();
    if (!trimmed) return { success: false, message: "content must not be empty" };

    const scan = scanContent(trimmed);
    if (scan.blocked) return { success: false, message: `rejected: ${scan.reason}` };

    // Dedup
    if (this.entries[target].includes(trimmed)) {
      return {
        success: false,
        message: "duplicate entry — already present",
        entryCount: this.entries[target].length,
      };
    }

    const next = [...this.entries[target], trimmed];
    const limitCheck = this.checkLimit(target, next);
    if (!limitCheck.ok) return { success: false, message: limitCheck.reason };

    this.entries[target] = next;
    await this.writeFileEntries(target);
    return this.okResult(target, "added");
  }

  async replace(target: MemoryTarget, oldText: string, newContent: string): Promise<MemoryWriteResult> {
    const oldTrim = oldText.trim();
    const newTrim = newContent.trim();
    if (!oldTrim || !newTrim) return { success: false, message: "old_text and content are required" };

    const scan = scanContent(newTrim);
    if (scan.blocked) return { success: false, message: `rejected: ${scan.reason}` };

    const idx = this.entries[target].findIndex((e) => e === oldTrim);
    if (idx < 0) return { success: false, message: "old_text not found as an entry" };

    const next = [...this.entries[target]];
    next[idx] = newTrim;
    const limitCheck = this.checkLimit(target, next);
    if (!limitCheck.ok) return { success: false, message: limitCheck.reason };

    this.entries[target] = next;
    await this.writeFileEntries(target);
    return this.okResult(target, "replaced");
  }

  async remove(target: MemoryTarget, oldText: string): Promise<MemoryWriteResult> {
    const oldTrim = oldText.trim();
    if (!oldTrim) return { success: false, message: "old_text is required" };

    const idx = this.entries[target].findIndex((e) => e === oldTrim);
    if (idx < 0) return { success: false, message: "old_text not found as an entry" };

    const next = [...this.entries[target]];
    next.splice(idx, 1);
    this.entries[target] = next;
    await this.writeFileEntries(target);
    return this.okResult(target, "removed");
  }

  listEntries(target: MemoryTarget): readonly string[] {
    return [...this.entries[target]];
  }

  // ── internals ─────────────────────────────────────────────────────────

  private path(target: MemoryTarget): string {
    return join(this.memoryDir, FILENAMES[target]);
  }

  private async readFileEntries(target: MemoryTarget): Promise<string[]> {
    try {
      const raw = await readFile(this.path(target), "utf-8");
      const parts = raw
        .split(ENTRY_DELIMITER)
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      // Dedup preserving first-seen order
      return Array.from(new Set(parts));
    } catch {
      return [];
    }
  }

  /** Atomic write via temp file + rename (safe under concurrent readers). */
  private async writeFileEntries(target: MemoryTarget): Promise<void> {
    const file = this.path(target);
    const content = this.entries[target].join(ENTRY_DELIMITER);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, content, { encoding: "utf-8" });
      await rename(tmp, file);
    } catch (e) {
      try { await unlink(tmp); } catch {}
      throw e;
    }
  }

  private renderBlock(target: MemoryTarget, entries: string[]): string {
    if (entries.length === 0) return "";
    const content = entries.join(ENTRY_DELIMITER);
    const limit = CHAR_LIMITS[target];
    const pct = Math.min(100, Math.round((content.length / limit) * 100));
    const header = target === "user"
      ? `USER PROFILE (who the user is) [${pct}% — ${content.length}/${limit} chars]`
      : `MEMORY (your persistent notes) [${pct}% — ${content.length}/${limit} chars]`;
    const sep = "=".repeat(46);
    return `${sep}\n${header}\n${sep}\n${content}`;
  }

  private checkLimit(target: MemoryTarget, entries: string[]): { ok: true } | { ok: false; reason: string } {
    const total = entries.join(ENTRY_DELIMITER).length;
    const limit = CHAR_LIMITS[target];
    if (total > limit) {
      return {
        ok: false,
        reason: `total ${total} chars exceeds ${target} limit ${limit} — remove or replace older entries first`,
      };
    }
    return { ok: true };
  }

  private okResult(target: MemoryTarget, verb: string): MemoryWriteResult {
    const entries = this.entries[target];
    const chars = entries.join(ENTRY_DELIMITER).length;
    return {
      success: true,
      message: `entry ${verb}`,
      entryCount: entries.length,
      chars,
      limit: CHAR_LIMITS[target],
    };
  }
}
