import { config } from "../config/default.js";

/**
 * A2A Agent Card - serves agent capabilities at /.well-known/agent.json
 *
 * SECURITY: Only serves the card when A2A is enabled.
 * Does NOT expose internal tools or file system capabilities.
 */
export function getAgentCard() {
  return {
    name: "Daemora",
    description:
      "A multi-agent digital worker. Handles research, analysis, and general tasks.",
    url: `http://localhost:${config.port}`,
    version: "1.0.0",
    protocol: "a2a/1.0",

    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitions: true,
    },

    // Only expose safe, high-level skill categories - NOT internal tools
    skills: [
      {
        id: "research",
        name: "Web Research",
        description: "Search the web and synthesize information.",
        tags: ["research", "search", "web"],
      },
      {
        id: "analysis",
        name: "Text Analysis",
        description: "Analyze text, summarize, answer questions.",
        tags: ["analysis", "summary", "qa"],
      },
      {
        id: "documents",
        name: "Document Creation",
        description: "Create markdown documents and reports.",
        tags: ["documents", "markdown"],
      },
    ],

    endpoints: {
      tasks: `/a2a/tasks`,
      taskStatus: `/a2a/tasks/:id`,
      stream: `/a2a/tasks/:id/stream`,
    },

    authentication: {
      type: config.a2a.authToken ? "bearer" : "none",
      description: config.a2a.authToken
        ? "Include Authorization: Bearer <token> header"
        : "No authentication required",
    },

    security: {
      permissionTier: config.a2a.permissionTier,
      rateLimitPerMinute: config.a2a.rateLimitPerMinute,
      note: "A2A tasks run with restricted permissions. Dangerous tools are blocked.",
    },
  };
}

/**
 * Mount A2A discovery endpoint on Express app.
 */
export function mountAgentCard(app) {
  app.get("/.well-known/agent.json", (req, res) => {
    if (!config.a2a.enabled) {
      return res.status(404).json({
        error: "A2A protocol is not enabled on this agent.",
      });
    }
    res.json(getAgentCard());
  });
}
