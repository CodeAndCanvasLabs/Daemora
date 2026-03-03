/**
 * Structured tool registry.
 * Each tool registers with metadata: name, category, params, permissionTier, isWrite, fn.
 * Replaces loose imports + string descriptions with a single source of truth.
 */
class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  /**
   * Register a tool with structured metadata.
   */
  register({ name, category, description, params, permissionTier, isWrite, fn }) {
    if (!name || !fn) throw new Error(`Tool registration requires name and fn`);
    this.tools.set(name, {
      name,
      category: category || "other",
      description: description || "",
      params: params || [],
      permissionTier: permissionTier || "full",
      isWrite: isWrite ?? false,
      fn,
    });
  }

  /**
   * Get tool function map { name: fn } - backward compatible with current toolFunctions export.
   */
  getToolFunctions() {
    const fns = {};
    for (const [name, tool] of this.tools) {
      fns[name] = tool.fn;
    }
    return fns;
  }

  /**
   * Get tool description strings - backward compatible with current toolDescriptions export.
   */
  getToolDescriptions() {
    const descs = [];
    for (const [, tool] of this.tools) {
      const paramStr = tool.params
        .map((p) => `${p.name}${p.required ? "" : "?"}: ${p.type}`)
        .join(", ");
      descs.push(`${tool.name}(${paramStr}) - ${tool.description}`);
    }
    return descs;
  }

  /**
   * Build tool docs for system prompt - grouped by category.
   */
  buildToolDocs() {
    const categories = {};
    for (const [, tool] of this.tools) {
      if (!categories[tool.category]) categories[tool.category] = [];
      categories[tool.category].push(tool);
    }

    const categoryLabels = {
      filesystem: "File Operations",
      search: "Search",
      system: "System",
      web: "Web & Browser",
      communication: "Communication",
      documents: "Documents",
      memory: "Memory",
      agents: "Agents",
      automation: "Automation",
      other: "Other",
    };

    let doc = "# Available Tools\n\nAll tool params are STRINGS. Pass them as an array of strings.\n";

    for (const [cat, tools] of Object.entries(categories)) {
      doc += `\n## ${categoryLabels[cat] || cat}\n\n`;
      for (const tool of tools) {
        const paramStr = tool.params
          .map((p) => `${p.name}${p.required ? "" : "?"}`)
          .join(", ");
        doc += `### ${tool.name}(${paramStr})\n`;
        doc += `${tool.description}\n`;
        if (tool.params.length > 0) {
          for (const p of tool.params) {
            doc += `- ${p.name}${p.required ? " (required)" : " (optional)"}: ${p.description || p.type}\n`;
          }
        }
        doc += "\n";
      }
    }

    return doc;
  }

  /**
   * Get tools allowed for a specific permission tier.
   */
  getToolsForTier(tier) {
    const tierOrder = { minimal: 0, standard: 1, full: 2 };
    const tierLevel = tierOrder[tier] ?? 2;
    const allowed = [];
    for (const [name, tool] of this.tools) {
      const toolLevel = tierOrder[tool.permissionTier] ?? 2;
      if (toolLevel <= tierLevel) {
        allowed.push(name);
      }
    }
    return allowed;
  }

  /**
   * Get write tool names (for SAFEGUARD 2 in AgentLoop).
   */
  getWriteTools() {
    const names = [];
    for (const [name, tool] of this.tools) {
      if (tool.isWrite) names.push(name);
    }
    return new Set(names);
  }

  /**
   * Get tool metadata by name.
   */
  get(name) {
    return this.tools.get(name);
  }

  /**
   * Get all tool names.
   */
  getNames() {
    return [...this.tools.keys()];
  }
}

// Singleton
const registry = new ToolRegistry();
export default registry;
