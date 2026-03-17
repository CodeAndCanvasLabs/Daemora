import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { clearRegistry, getRegistry } from "../../../src/plugins/PluginRegistry.js";

const TEST_PLUGINS_DIR = join(process.cwd(), "plugins", "__test-plugin__");

describe("PluginLoader", () => {
  beforeEach(() => {
    clearRegistry();
    if (existsSync(TEST_PLUGINS_DIR)) rmSync(TEST_PLUGINS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_PLUGINS_DIR)) rmSync(TEST_PLUGINS_DIR, { recursive: true });
  });

  it("loads plugin with plugin.json + index.js", async () => {
    // Create test plugin
    mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
    writeFileSync(join(TEST_PLUGINS_DIR, "plugin.json"), JSON.stringify({
      id: "__test-plugin__",
      name: "Test Plugin",
      version: "1.0.0",
    }));
    writeFileSync(join(TEST_PLUGINS_DIR, "index.js"), `
      export default {
        id: "__test-plugin__",
        register(api) {
          api.registerTool("testTool", () => "hello", null, "test tool");
        }
      };
    `);

    const { loadPlugins } = await import("../../../src/plugins/PluginLoader.js");
    // Force reload
    clearRegistry();
    const registry = await loadPlugins();

    const plugin = registry.plugins.find(p => p.id === "__test-plugin__");
    expect(plugin).toBeTruthy();
    expect(plugin.status).toBe("loaded");
    expect(plugin.toolNames).toContain("testTool");
  });

  it("auto-discovers tools from provides.tools glob", async () => {
    mkdirSync(join(TEST_PLUGINS_DIR, "tools"), { recursive: true });
    writeFileSync(join(TEST_PLUGINS_DIR, "plugin.json"), JSON.stringify({
      id: "__test-plugin__",
      name: "Test Auto-Discovery",
      provides: { tools: ["tools/*.js"] },
    }));
    writeFileSync(join(TEST_PLUGINS_DIR, "tools", "greet.js"), `
      export default function greet(name) { return "Hi " + (name || "world"); }
      export const description = "greet tool";
    `);

    const { loadPlugins } = await import("../../../src/plugins/PluginLoader.js");
    clearRegistry();
    const registry = await loadPlugins();

    const plugin = registry.plugins.find(p => p.id === "__test-plugin__");
    expect(plugin).toBeTruthy();
    expect(plugin.toolNames).toContain("greet");

    const greetTool = registry.tools.find(t => t.name === "greet");
    expect(greetTool).toBeTruthy();
    expect(greetTool.fn("test")).toBe("Hi test");
  });

  it("handles missing plugin.json gracefully", async () => {
    mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
    // No plugin.json — should skip

    const { loadPlugins } = await import("../../../src/plugins/PluginLoader.js");
    clearRegistry();
    const registry = await loadPlugins();

    const plugin = registry.plugins.find(p => p.id === "__test-plugin__");
    expect(plugin).toBeFalsy();
  });

  it("records error for broken plugins", async () => {
    mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
    writeFileSync(join(TEST_PLUGINS_DIR, "plugin.json"), JSON.stringify({
      id: "__test-plugin__",
      name: "Broken Plugin",
    }));
    writeFileSync(join(TEST_PLUGINS_DIR, "index.js"), `
      throw new Error("intentional break");
    `);

    const { loadPlugins } = await import("../../../src/plugins/PluginLoader.js");
    clearRegistry();
    const registry = await loadPlugins();

    const plugin = registry.plugins.find(p => p.id === "__test-plugin__");
    expect(plugin).toBeTruthy();
    expect(plugin.status).toBe("error");
    expect(plugin.error).toContain("intentional break");
  });
});
