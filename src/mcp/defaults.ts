/**
 * Built-in MCP server catalog.
 *
 * Seeded into the user's `mcp.json` on first boot when the file doesn't
 * exist. Everything ships **disabled** — the user enables individual
 * servers via the `manage_mcp` tool or the Settings / MCP UI once the
 * required credentials are filled in.
 *
 * Each entry also declares:
 *   • `description` — one-line summary shown in the UI.
 *   • `requiredEnv` — env-var names that must be non-empty before the
 *     server can be activated. Lets the MCP page show a friendly
 *     "Needs config" state and prompt for values before enabling.
 */

import { homedir } from "node:os";

import type { MCPServerConfig } from "./MCPStore.js";

export interface MCPArgField {
  /** Positional index into `config.args` that this field occupies. */
  readonly index: number;
  /** Human label shown in the UI. */
  readonly label: string;
  /** One-line hint rendered below the input. */
  readonly hint?: string;
  /** "path" = directory picker, "text" = plain string. */
  readonly kind?: "path" | "text";
}

export interface MCPDefault {
  readonly description: string;
  readonly config: MCPServerConfig;
  /** Env vars that must be non-empty before the server can be activated. */
  readonly requiredEnv?: readonly string[];
  /**
   * Positional args the user can customise (path, DB URL, etc.). The UI
   * uses these to render inputs alongside the env form — the server
   * is still activatable when the inline args default is reasonable,
   * so `requiredArgs` doesn't gate activation, just surfaces an edit
   * affordance.
   */
  readonly argFields?: readonly MCPArgField[];
  /** URL of the project page — for UI "learn more" links. */
  readonly docsUrl?: string;
}

/**
 * Default filesystem path the agent's filesystem MCP server mounts.
 * We prefer the user's home directory over the JS seed's
 * `/Users/you/Projects` placeholder — that path doesn't exist on real
 * machines and caused the server to crash on first activate. The user
 * can narrow this via the UI (`argFields` below) once we land the
 * activation dialog.
 */
const DEFAULT_FS_PATH = homedir();

export const MCP_DEFAULTS: Readonly<Record<string, MCPDefault>> = {
  memory: {
    description: "Persistent memory via knowledge graph. No API key needed.",
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], enabled: false },
  },
  filesystem: {
    description: "Secure file access — set allowed directory paths in args.",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", DEFAULT_FS_PATH],
      enabled: false,
    },
    argFields: [
      { index: 2, label: "Allowed directory", kind: "path", hint: "Absolute path the MCP server is allowed to read/write." },
    ],
  },
  postgres: {
    description: "PostgreSQL database access (read-only SQL).",
    config: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://user:pass@localhost:5432/mydb",
      ],
      enabled: false,
    },
    argFields: [
      { index: 2, label: "Connection string", kind: "text", hint: "e.g. postgresql://user:pass@host:5432/db" },
    ],
  },
  github: {
    description: "GitHub — repos, PRs, issues, Actions, code search (OAuth, remote).",
    docsUrl: "https://github.com/github/github-mcp-server",
    config: {
      // Remote HTTP MCP hosted by GitHub. The bearer is injected by
      // MCPIntegrationBridge whenever a GitHub account is connected in
      // Integrations, so users don't edit this entry by hand.
      url: "https://api.githubcopilot.com/mcp",
      headers: { Authorization: "Bearer ${INTEGRATION:github}" },
      enabled: false,
    },
  },
  "brave-search": {
    description: "Brave Search — web, news, image search.",
    docsUrl: "https://brave.com/search/api/",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      env: { BRAVE_API_KEY: "" },
      enabled: false,
    },
    requiredEnv: ["BRAVE_API_KEY"],
  },
  slack: {
    description: "Slack workspace integration.",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
      enabled: false,
    },
    requiredEnv: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
  },
  puppeteer: {
    description: "Browser automation, screenshots, web interaction.",
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"], enabled: false },
  },
  sentry: {
    description: "Sentry error tracking — query issues, generate patches.",
    config: {
      command: "npx",
      args: ["-y", "@sentry/mcp-server@latest"],
      env: { SENTRY_AUTH_TOKEN: "" },
      enabled: false,
    },
    requiredEnv: ["SENTRY_AUTH_TOKEN"],
  },
  "sequential-thinking": {
    description: "Structured problem solving — step-by-step reasoning chains.",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      enabled: false,
    },
  },
  notion: {
    description: "Notion — pages, databases, search, comments (OAuth, remote).",
    docsUrl: "https://developers.notion.com/docs/get-started-with-mcp",
    config: {
      // Remote HTTP MCP hosted by Notion. Bearer is injected by
      // MCPIntegrationBridge after a Notion workspace is connected.
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${INTEGRATION:notion}" },
      enabled: false,
    },
  },
  linear: {
    description: "Linear — issues, projects, teams, sprints.",
    config: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], enabled: false },
  },
  hubspot: {
    description: "HubSpot CRM — contacts, deals, companies, tickets.",
    config: {
      command: "npx",
      args: ["-y", "@hubspot/mcp-server"],
      env: { PRIVATE_APP_ACCESS_TOKEN: "" },
      enabled: false,
    },
    requiredEnv: ["PRIVATE_APP_ACCESS_TOKEN"],
  },
  stripe: {
    description: "Stripe — payments, invoices, subscriptions, customers.",
    config: {
      command: "npx",
      args: ["-y", "@stripe/mcp", "--tools=all"],
      env: { STRIPE_SECRET_KEY: "" },
      enabled: false,
    },
    requiredEnv: ["STRIPE_SECRET_KEY"],
  },
  jira: {
    description: "Jira — issues, projects, sprints, JQL search.",
    config: {
      command: "npx",
      args: ["-y", "@aashari/mcp-server-atlassian-jira"],
      env: { ATLASSIAN_SITE_NAME: "", ATLASSIAN_USER_EMAIL: "", ATLASSIAN_API_TOKEN: "" },
      enabled: false,
    },
    requiredEnv: ["ATLASSIAN_SITE_NAME", "ATLASSIAN_USER_EMAIL", "ATLASSIAN_API_TOKEN"],
  },
  confluence: {
    description: "Confluence — spaces, pages, search, content.",
    config: {
      command: "npx",
      args: ["-y", "@aashari/mcp-server-atlassian-confluence"],
      env: { ATLASSIAN_SITE_NAME: "", ATLASSIAN_USER_EMAIL: "", ATLASSIAN_API_TOKEN: "" },
      enabled: false,
    },
    requiredEnv: ["ATLASSIAN_SITE_NAME", "ATLASSIAN_USER_EMAIL", "ATLASSIAN_API_TOKEN"],
  },
  figma: {
    description: "Figma — design data, layouts, styles, components.",
    config: {
      command: "npx",
      args: ["-y", "figma-developer-mcp", "--figma-api-key=YOUR_FIGMA_TOKEN", "--stdio"],
      enabled: false,
    },
  },
  gdrive: {
    description: "Google Drive — files, folders, search.",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gdrive"],
      env: { GDRIVE_CREDENTIALS_PATH: "" },
      enabled: false,
    },
    requiredEnv: ["GDRIVE_CREDENTIALS_PATH"],
  },
  "google-maps": {
    description: "Google Maps — geocoding, directions, places, elevation.",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-google-maps"],
      env: { GOOGLE_MAPS_API_KEY: "" },
      enabled: false,
    },
    requiredEnv: ["GOOGLE_MAPS_API_KEY"],
  },
  firecrawl: {
    description: "Firecrawl — web scraping, crawling, content extraction.",
    config: {
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: { FIRECRAWL_API_KEY: "" },
      enabled: false,
    },
    requiredEnv: ["FIRECRAWL_API_KEY"],
  },
  tavily: {
    description: "Tavily — real-time web search, data extraction.",
    config: {
      command: "npx",
      args: ["-y", "tavily-mcp@latest"],
      env: { TAVILY_API_KEY: "" },
      enabled: false,
    },
    requiredEnv: ["TAVILY_API_KEY"],
  },
  cloudflare: {
    description: "Cloudflare — Workers, KV, R2, D1 management.",
    config: { command: "npx", args: ["-y", "@cloudflare/mcp-server-cloudflare"], enabled: false },
  },
  upstash: {
    description: "Upstash — serverless Redis and message queues.",
    config: {
      command: "npx",
      args: ["-y", "@upstash/mcp-server"],
      env: { UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" },
      enabled: false,
    },
    requiredEnv: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  },
};

/** Backwards-compat export — the plain config map used by MCPStore seeding. */
export const BUILTIN_MCP_SERVERS: Readonly<Record<string, MCPServerConfig>> = Object.fromEntries(
  Object.entries(MCP_DEFAULTS).map(([name, def]) => [name, def.config]),
);

/** Look up required env keys for a built-in server. Returns empty array for unknown servers. */
export function requiredEnvFor(name: string): readonly string[] {
  return MCP_DEFAULTS[name]?.requiredEnv ?? [];
}

/** Look up arg-field metadata (path / text positional args the user can edit). */
export function argFieldsFor(name: string): readonly MCPArgField[] {
  return MCP_DEFAULTS[name]?.argFields ?? [];
}

/** One-line description lookup. */
export function descriptionFor(name: string): string | undefined {
  return MCP_DEFAULTS[name]?.description;
}
