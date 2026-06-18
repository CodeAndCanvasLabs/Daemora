/**
 * CrewRegistry — in-memory lookup for loaded crews. The host never
 * builds or spawns crews directly; it looks them up here, then hands
 * off to CrewAgentRunner for execution.
 *
 * Crews can come from two sources:
 *   - Filesystem: scanned at startup by CrewLoader.
 *   - Runtime: integrations register their crew when the user connects
 *     the integration, then unregister on disconnect. The "change"
 *     event lets AgentLoop invalidate its cached system prompt so the
 *     main agent's `use_crew` list stays in sync.
 */

import { EventEmitter } from "node:events";

import { NotFoundError } from "../util/errors.js";
import type { LoadedCrew } from "./types.js";

export class CrewRegistry extends EventEmitter {
  private readonly byId: Map<string, LoadedCrew>;

  constructor(crews: readonly LoadedCrew[]) {
    super();
    this.byId = new Map(crews.map((c) => [c.manifest.id, c]));
  }

  /** Add or replace a crew at runtime. Fires "change". */
  register(crew: LoadedCrew): void {
    this.byId.set(crew.manifest.id, crew);
    this.emit("change", { op: "register", id: crew.manifest.id });
  }

  /** Remove a crew at runtime. No-op if not present. Fires "change" when it was. */
  unregister(id: string): boolean {
    const existed = this.byId.delete(id);
    if (existed) this.emit("change", { op: "unregister", id });
    return existed;
  }

  get size(): number {
    return this.byId.size;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): LoadedCrew {
    const c = this.byId.get(id);
    if (!c) throw new NotFoundError(`Crew not found: ${id}`, { knownCrews: Array.from(this.byId.keys()) });
    return c;
  }

  tryGet(id: string): LoadedCrew | undefined {
    return this.byId.get(id);
  }

  list(): readonly LoadedCrew[] {
    return Array.from(this.byId.values());
  }

  /**
   * Crews the active profile permits the main agent to see. Hidden
   * crews still exist in `byId` — `use_crew("hidden-id", ...)` would
   * still work — they're just not in the surface the agent picks from.
   * Omit / empty include → all visible (legacy behaviour).
   */
  listForProfile(filter?: { include?: readonly string[]; exclude?: readonly string[] } | undefined): readonly LoadedCrew[] {
    const all = this.list();
    if (!filter) return all;
    const include = filter.include && filter.include.length > 0 ? new Set(filter.include) : null;
    const exclude = filter.exclude && filter.exclude.length > 0 ? new Set(filter.exclude) : null;
    if (!include && !exclude) return all;
    return all.filter((c) => {
      if (include && !include.has(c.manifest.id)) return false;
      if (exclude && exclude.has(c.manifest.id)) return false;
      return true;
    });
  }

  /**
   * Compact one-liner list the main agent's system prompt can render.
   * If `filter` is provided, only profile-permitted crews appear in
   * the prompt — the rest are reachable by id but invisible to the
   * model's default decision surface.
   */
  summaryLines(filter?: { include?: readonly string[]; exclude?: readonly string[] } | undefined): readonly string[] {
    return this.listForProfile(filter).map((c) => `- ${c.manifest.id}: ${c.manifest.description}`);
  }
}
