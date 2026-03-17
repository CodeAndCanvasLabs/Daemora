import { describe, it, expect, beforeEach } from "vitest";
import {
  getRegistry,
  clearRegistry,
  createPluginApi,
  getPlugins,
  getPluginTools,
  getPluginChannels,
  getPluginServices,
  getPluginHooks,
  getPlugin,
  getPluginToolsForPlan,
  getPluginToolsForScope,
} from "../../../src/plugins/PluginRegistry.js";

describe("PluginRegistry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe("clearRegistry", () => {
    it("resets all registry arrays", () => {
      const r = getRegistry();
      r.plugins.push({ id: "test" });
      r.tools.push({ name: "testTool" });
      clearRegistry();
      expect(getPlugins()).toHaveLength(0);
      expect(getPluginTools()).toHaveLength(0);
    });
  });

  describe("createPluginApi", () => {
    it("returns api object with all registration methods", () => {
      const record = { id: "test", name: "Test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp/test");

      expect(api.id).toBe("test");
      expect(api.name).toBe("Test");
      expect(typeof api.registerTool).toBe("function");
      expect(typeof api.registerChannel).toBe("function");
      expect(typeof api.on).toBe("function");
      expect(typeof api.registerService).toBe("function");
      expect(typeof api.registerCli).toBe("function");
      expect(typeof api.registerRoute).toBe("function");
      expect(typeof api.config).toBe("function");
      expect(typeof api.setConfig).toBe("function");
      expect(typeof api.getTenantConfig).toBe("function");
      expect(typeof api.getTenantKeys).toBe("function");
      expect(typeof api.log.info).toBe("function");
      expect(typeof api.log.warn).toBe("function");
      expect(typeof api.log.error).toBe("function");
    });

    it("registerTool adds tool to registry", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp");
      const fn = () => "result";

      api.registerTool("myTool", fn, null, "my tool description");

      expect(getPluginTools()).toHaveLength(1);
      expect(getPluginTools()[0].name).toBe("myTool");
      expect(getPluginTools()[0].fn()).toBe("result");
      expect(getPluginTools()[0].pluginId).toBe("test");
      expect(record.toolNames).toContain("myTool");
    });

    it("registerTool rejects invalid tool", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp");

      api.registerTool("", () => {});
      api.registerTool("name", null);

      expect(getPluginTools()).toHaveLength(0);
    });

    it("on() registers hooks into EventBus", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp");
      const handler = () => {};

      api.on("task:end", handler);

      expect(getPluginHooks()).toHaveLength(1);
      expect(getPluginHooks()[0].event).toBe("task:end");
      expect(record.hookEvents).toContain("task:end");
    });

    it("on() handles array of events", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp");

      api.on(["task:start", "task:end"], () => {});

      expect(getPluginHooks()).toHaveLength(2);
      expect(record.hookEvents).toContain("task:start");
      expect(record.hookEvents).toContain("task:end");
    });

    it("registerService adds service", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp");

      api.registerService({ id: "my-service", start: async () => {}, stop: async () => {} });

      expect(getPluginServices()).toHaveLength(1);
      expect(getPluginServices()[0].id).toBe("my-service");
      expect(record.serviceIds).toContain("my-service");
    });

    it("registerRoute tracks HTTP routes", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const api = createPluginApi(record, {}, "/tmp");

      api.registerRoute("GET", "/status", () => {});

      const routes = getRegistry().httpRoutes;
      expect(routes).toHaveLength(1);
      expect(routes[0].method).toBe("GET");
      expect(routes[0].path).toBe("/api/plugins/test/status");
      expect(record.httpRouteCount).toBe(1);
    });

    it("config() reads from env with plugin prefix", () => {
      const record = { id: "my-plugin", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      process.env.PLUGIN_MY_PLUGIN_API_KEY = "test-key-123";
      const api = createPluginApi(record, {}, "/tmp");

      expect(api.config("API_KEY")).toBe("test-key-123");
      delete process.env.PLUGIN_MY_PLUGIN_API_KEY;
    });

    it("config() falls back to manifest default", () => {
      const record = { id: "test", toolNames: [], channelIds: [], hookEvents: [], serviceIds: [], cliCommands: [], httpRouteCount: 0 };
      const manifest = { config: { REGION: { default: "us-east-1" } } };
      const api = createPluginApi(record, manifest, "/tmp");

      expect(api.config("REGION")).toBe("us-east-1");
    });
  });

  describe("getPlugin", () => {
    it("finds plugin by id", () => {
      getRegistry().plugins.push({ id: "abc", name: "ABC" });
      expect(getPlugin("abc").name).toBe("ABC");
    });

    it("returns null for unknown id", () => {
      expect(getPlugin("unknown")).toBeNull();
    });
  });

  describe("getPluginToolsForPlan", () => {
    it("returns all tools when no plan specified", () => {
      getRegistry().tools.push({ pluginId: "p1", name: "t1" });
      getRegistry().plugins.push({ id: "p1", tenantPlans: ["pro"] });

      expect(getPluginToolsForPlan(null)).toHaveLength(1);
    });

    it("filters tools by tenant plan", () => {
      getRegistry().tools.push({ pluginId: "p1", name: "t1" });
      getRegistry().tools.push({ pluginId: "p2", name: "t2" });
      getRegistry().plugins.push({ id: "p1", tenantPlans: ["pro", "admin"] });
      getRegistry().plugins.push({ id: "p2", tenantPlans: ["admin"] });

      const proTools = getPluginToolsForPlan("pro");
      expect(proTools).toHaveLength(1);
      expect(proTools[0].name).toBe("t1");
    });

    it("includes tools with no plan restriction", () => {
      getRegistry().tools.push({ pluginId: "p1", name: "t1" });
      getRegistry().plugins.push({ id: "p1" }); // no tenantPlans

      expect(getPluginToolsForPlan("free")).toHaveLength(1);
    });
  });

  describe("getPluginToolsForScope", () => {
    it("filters by agent scope", () => {
      getRegistry().tools.push({ pluginId: "p1", name: "t1" });
      getRegistry().tools.push({ pluginId: "p2", name: "t2" });
      getRegistry().plugins.push({ id: "p1", agentScope: ["main"] });
      getRegistry().plugins.push({ id: "p2", agentScope: ["sub-agent"] });

      const mainTools = getPluginToolsForScope("main");
      expect(mainTools).toHaveLength(1);
      expect(mainTools[0].name).toBe("t1");
    });

    it("includes tools with no scope restriction", () => {
      getRegistry().tools.push({ pluginId: "p1", name: "t1" });
      getRegistry().plugins.push({ id: "p1" }); // no agentScope

      expect(getPluginToolsForScope("sub-agent")).toHaveLength(1);
    });
  });
});
