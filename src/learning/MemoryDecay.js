/**
 * MemoryDecay - automated confidence decay and cleanup for three-layer memory.
 *
 * Runs as a daily job via Heartbeat:
 * - Episodic: confidence = e^(-0.02 × days) — half-life ~35 days. Delete at < 0.1
 * - Procedural: confidence grows with usage: min(1.0, 0.7 + 0.05 × access_count). Never auto-deleted.
 * - Semantic: never decays. Only superseded explicitly by extraction pipeline.
 * - Superseded memories: deleted after 14 days.
 */

import { queryAll, run, transaction } from "../storage/Database.js";

const EPISODIC_DECAY_RATE = 0.02;      // ~35 day half-life
const EPISODIC_DELETE_THRESHOLD = 0.1;
const SUPERSEDED_TTL_DAYS = 14;

/**
 * Run full decay cycle. Returns { decayed, boosted, deleted, supersededCleaned }.
 */
export function runDecayCycle() {
  const now = Date.now();
  let decayed = 0;
  let boosted = 0;
  let deleted = 0;
  let supersededCleaned = 0;

  transaction(() => {
    // 1. Episodic decay
    const episodic = queryAll(
      "SELECT id, created_at, confidence FROM memory_entries WHERE memory_type = 'episodic' AND superseded_by IS NULL"
    );
    for (const m of episodic) {
      const ageMs = now - new Date(m.created_at).getTime();
      const ageDays = ageMs / 86400000;
      const newConf = Math.exp(-EPISODIC_DECAY_RATE * ageDays);

      if (newConf < EPISODIC_DELETE_THRESHOLD) {
        run("DELETE FROM memory_entries WHERE id = $id", { $id: m.id });
        deleted++;
      } else if (Math.abs(newConf - (m.confidence || 1.0)) > 0.01) {
        run("UPDATE memory_entries SET confidence = $conf WHERE id = $id", { $conf: newConf, $id: m.id });
        decayed++;
      }
    }

    // 2. Procedural boost (grows with usage)
    const procedural = queryAll(
      "SELECT id, access_count, confidence FROM memory_entries WHERE memory_type = 'procedural' AND superseded_by IS NULL"
    );
    for (const m of procedural) {
      const targetConf = Math.min(1.0, 0.7 + 0.05 * (m.access_count || 0));
      if (Math.abs(targetConf - (m.confidence || 1.0)) > 0.01) {
        run("UPDATE memory_entries SET confidence = $conf WHERE id = $id", { $conf: targetConf, $id: m.id });
        boosted++;
      }
    }

    // 3. Clean superseded memories older than TTL
    const cutoff = new Date(now - SUPERSEDED_TTL_DAYS * 86400000).toISOString();
    const superseded = queryAll(
      "SELECT id FROM memory_entries WHERE superseded_by IS NOT NULL AND created_at < $cutoff",
      { $cutoff: cutoff }
    );
    for (const m of superseded) {
      run("DELETE FROM memory_entries WHERE id = $id", { $id: m.id });
      supersededCleaned++;
    }
  });

  if (decayed || boosted || deleted || supersededCleaned) {
    console.log(`[MemoryDecay] Cycle: ${decayed} decayed, ${boosted} boosted, ${deleted} expired, ${supersededCleaned} superseded cleaned`);
  }

  return { decayed, boosted, deleted, supersededCleaned };
}
