/**
 * CrewLoader — scans `<crewRoot>/*\/plugin.json`, validates manifests,
 * resolves tool names against the active ToolRegistry, and returns the
 * set of crews the host process can actually run right now.
 *
 * Philosophy: fail LOUD on structural problems (malformed JSON, missing
 * id, invalid schema) — those are bugs. Fail SOFT on per-tool misses —
 * tools come and go with integrations, and we'd rather ship a crew with
 * 6/8 tools than refuse to load it entirely.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ToolRegistry } from "../tools/registry.js";
import { createLogger } from "../util/logger.js";
import { crewManifestSchema, type CrewManifest, type LoadedCrew } from "./types.js";

const log = createLogger("crew.loader");

export interface CrewLoadResult {
  readonly loaded: readonly LoadedCrew[];
  readonly skipped: readonly { dir: string; reason: string }[];
}

export class CrewLoader {
  constructor(private readonly root: string) {}

  /** Root directory crews live in — exposed so callers can resolve
   *  a crew's manifest file path for in-place edits. */
  get rootDir(): string {
    return resolve(this.root);
  }

  /**
   * Re-scan disk and return the single crew whose manifest id matches.
   * Used by the `PUT /api/crew/:id/profile` path to hot-reload a crew
   * after its plugin.json has been rewritten, without doing a full
   * crew directory rescan.
   */
  async loadOne(id: string, registry: ToolRegistry): Promise<LoadedCrew | null> {
    const { loaded } = await this.loadAll(registry);
    return loaded.find((c) => c.manifest.id === id) ?? null;
  }

  async loadAll(registry: ToolRegistry): Promise<CrewLoadResult> {
    const root = resolve(this.root);
    const registered = new Set(registry.list().map((t) => t.name));

    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        log.warn({ root }, "crew root missing — no crews loaded");
        return { loaded: [], skipped: [] };
      }
      throw e;
    }

    const loaded: LoadedCrew[] = [];
    const skipped: { dir: string; reason: string }[] = [];

    for (const entry of entries) {
      if (entry.startsWith(".") || entry.startsWith("_")) continue;
      const dir = join(root, entry);
      const manifestPath = join(dir, "plugin.json");

      let s;
      try {
        s = await stat(dir);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;

      let raw: string;
      try {
        raw = await readFile(manifestPath, "utf-8");
      } catch {
        skipped.push({ dir, reason: "no plugin.json" });
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        skipped.push({ dir, reason: `invalid JSON: ${(e as Error).message}` });
        continue;
      }

      // Soft-fix common overflow: a too-long description shouldn't drop
      // the whole crew. Truncate to the schema max and warn so users see
      // the issue at startup instead of getting a silently-missing crew.
      if (typeof (json as { description?: unknown }).description === "string") {
        const desc = (json as { description: string }).description;
        if (desc.length > 2000) {
          (json as { description: string }).description = `${desc.slice(0, 1997)}...`;
          log.warn({ dir, originalLength: desc.length }, "crew description over 2000 chars — auto-truncated");
        }
      }

      const parsed = crewManifestSchema.safeParse(json);
      if (!parsed.success) {
        skipped.push({ dir, reason: `invalid schema: ${parsed.error.message.slice(0, 200)}` });
        continue;
      }

      const resolvedTools: string[] = [];
      const droppedTools: string[] = [];
      for (const t of parsed.data.tools) {
        (registered.has(t) ? resolvedTools : droppedTools).push(t);
      }

      if (droppedTools.length > 0) {
        log.warn(
          { crew: parsed.data.id, dropped: droppedTools },
          "crew references unavailable tools — loading with reduced tool set",
        );
      }

      loaded.push({ manifest: parsed.data, dir, resolvedTools, droppedTools });
    }

    log.info({ root, loaded: loaded.length, skipped: skipped.length }, "crew scan complete");
    return { loaded, skipped };
  }
}

/** Convenience: reveal manifest fields in a uniform shape for the CrewRegistry. */
export function crewManifestDigest(m: CrewManifest): {
  id: string;
  name: string;
  description: string;
  model: string | null;
  temperature: number;
} {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    model: m.profile.model ?? null,
    temperature: m.profile.temperature,
  };
}
