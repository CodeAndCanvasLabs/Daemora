export default {
  id: "notion",
  name: "Notion",

  register(api) {
    // Notion crew delegates to MCP Notion tools — no custom tools needed.
    // The specialized system prompt guides the agent to use useMCP("Notion", task).
    api.log.info("Notion crew registered (MCP delegate)");
  },
};
