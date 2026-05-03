/**
 * ToolRegistry — central place tools register themselves.
 *
 * Two responsibilities:
 *   1. Hold every known tool keyed by name (no duplicates allowed).
 *   2. Build the model-facing tool list per request: always-on tools
 *      + tools matched by skill discovery, with tools from disabled
 *      integrations excluded.
 */

import { ValidationError } from "../util/errors.js";
import type { ToolDef } from "./types.js";

export interface ToolFilter {
  /** Integration IDs the user has enabled. Tools sourced from disabled integrations are excluded. */
  readonly enabledIntegrations: ReadonlySet<string>;
  /** Tool names the agent can additionally see this turn (from skill matching). */
  readonly skillMatchedTools?: ReadonlySet<string>;
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.byName.has(def.name)) {
      throw new ValidationError(`Duplicate tool registration: "${def.name}"`, {
        existing_source: this.byName.get(def.name)!.source,
        new_source: def.source,
      });
    }
    this.byName.set(def.name, def);
  }

  registerAll(defs: readonly ToolDef[]): void {
    for (const d of defs) this.register(d);
  }

  /**
   * Remove a single tool by name. Returns true if it existed and was
   * removed, false otherwise. Used by start.ts to swap a basic tool
   * (registered at AgentLoop construction) for a channel-aware variant
   * once ChannelManager has been built.
   */
  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  unregisterBySource(source: ToolDef["source"]): number {
    let removed = 0;
    for (const [name, def] of this.byName) {
      if (sameSource(def.source, source)) {
        this.byName.delete(name);
        removed++;
      }
    }
    return removed;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): ToolDef | undefined {
    return this.byName.get(name);
  }

  list(): readonly ToolDef[] {
    return Array.from(this.byName.values());
  }

  /** Tools available given the user's currently-enabled integrations. */
  available(enabledIntegrations: ReadonlySet<string>): readonly ToolDef[] {
    return this.list().filter((d) => {
      if (d.source.kind === "integration") return enabledIntegrations.has(d.source.id);
      return true;
    });
  }

  /**
   * Build the tool list to send to the model on this turn.
   * Includes:
   *   - All `alwaysOn` tools (delegate, discoverTools, core io)
   *   - Tools whose name appears in `skillMatchedTools`
   * Excludes tools from disabled integrations entirely.
   */
  selectFor(filter: ToolFilter): readonly ToolDef[] {
    const matched = filter.skillMatchedTools ?? new Set<string>();
    return this.available(filter.enabledIntegrations).filter(
      (d) => d.alwaysOn === true || matched.has(d.name),
    );
  }
}

function sameSource(a: ToolDef["source"], b: ToolDef["source"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "core") return true;
  // narrowed: both are integration | crew with same kind
  return (a as { id: string }).id === (b as { id: string }).id;
}
