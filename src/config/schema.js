import { z } from "zod";

// --- Reusable helpers ---

const stringOrNull = z.string().nullable().default(null);
const stringArray = z.array(z.string()).default([]);
const portNumber = z.number().int().min(1).max(65535);

/** Provider:model format — loose check, just requires the colon separator. */
const modelString = z.string().regex(/^[a-z0-9_-]+:.+$/i, "Must be provider:model format");

/** Base channel schema — every channel has at least `enabled`. */
const channelBase = z.object({
  enabled: z.boolean().default(false),
  allowlist: stringArray,
  model: stringOrNull,
}).strict();

/** Extend channelBase with extra credential fields per channel. */
const channelWith = (extra) => channelBase.extend(extra).strict();

// --- Top-level schema ---

export const ConfigSchema = z.object({
  // Server
  port: portNumber.default(8081),

  // Paths (string type-check only)
  rootDir:       z.string(),
  dataDir:       z.string(),
  sessionsDir:   z.string(),
  tasksDir:      z.string(),
  memoryDir:     z.string(),
  auditDir:      z.string(),
  costsDir:      z.string(),
  workspacesDir: z.string(),
  skillsDir:     z.string(),
  soulPath:      z.string(),
  memoryPath:    z.string(),

  // Models
  defaultModel:   modelString.nullable().default(null),
  subAgentModel:  stringOrNull,

  // Agent loop
  maxLoops:          z.number().int().min(1).max(200).default(40),
  maxSubAgentDepth:  z.number().int().min(1).max(10).default(3),

  // Thinking
  thinkingLevel: z.enum(["auto", "off", "minimal", "low", "medium", "high", "xhigh"]).default("auto"),

  // Queue
  queueMode:   z.enum(["steer", "collect", "followup"]).default("steer"),
  debounceMs:  z.number().int().min(0).max(30000).default(1500),

  // Safety
  permissionTier: z.enum(["minimal", "standard", "full"]).default("standard"),

  // Cost limits
  maxCostPerTask: z.number().positive().default(0.50),
  maxDailyCost:   z.number().positive().default(10.00),

  // Auto-capture memory
  autoCapture: z.boolean().default(true),

  // Cleanup
  cleanupAfterDays: z.number().int().min(0).default(30),

  // Daemon
  daemonMode:               z.boolean().default(false),
  heartbeatIntervalMinutes: z.number().int().min(1).max(1440).default(30),

  // Twilio / Meeting
  twilioPhoneNumber: stringOrNull,
  daemoraPublicUrl:  stringOrNull,

  // A2A Security
  a2a: z.object({
    enabled:            z.boolean().default(false),
    authToken:          stringOrNull,
    allowedAgents:      stringArray,
    permissionTier:     z.enum(["minimal", "standard", "full"]).default("minimal"),
    maxCostPerTask:     z.number().positive().default(0.05),
    rateLimitPerMinute: z.number().int().min(1).default(5),
    blockedTools:       z.array(z.string()).default(["executeCommand", "writeFile", "editFile", "sendEmail", "spawnAgent"]),
  }).strict().default({}),

  // Filesystem sandboxing
  filesystem: z.object({
    allowedPaths:     stringArray,
    blockedPaths:     stringArray,
    restrictCommands: z.boolean().default(false),
  }).strict().default({}),

  // Multi-tenant
  multiTenant: z.object({
    enabled:            z.boolean().default(false),
    autoRegister:       z.boolean().default(true),
    isolateFilesystem:  z.boolean().default(false),
  }).strict().default({}),

  // Sandbox
  sandbox: z.object({
    mode:          z.enum(["process", "docker"]).default("process"),
    dockerImage:   z.string().default("node:22-alpine"),
    dockerMemory:  z.string().default("512m"),
    dockerCpus:    z.string().default("0.5"),
    dockerNetwork: z.string().default("none"),
  }).strict().default({}),

  // Channels
  channels: z.object({
    http: z.object({
      enabled: z.boolean().default(false),
    }).strict().default({}),

    telegram: channelWith({
      token: stringOrNull,
    }).default({}),

    whatsapp: channelWith({
      accountSid: stringOrNull,
      authToken:  stringOrNull,
      from:       stringOrNull,
    }).default({}),

    email: channelWith({
      resendApiKey: stringOrNull,
      resendFrom:   stringOrNull,
      imap: z.object({
        host: z.string().default("imap.gmail.com"),
        port: portNumber.default(993),
      }).strict().default({}),
      smtp: z.object({
        host: z.string().default("smtp.gmail.com"),
        port: portNumber.default(587),
      }).strict().default({}),
      user:     stringOrNull,
      password: stringOrNull,
    }).default({}),

    discord: channelWith({
      token: stringOrNull,
    }).default({}),

    slack: channelWith({
      botToken: stringOrNull,
      appToken: stringOrNull,
    }).default({}),

    line: channelWith({
      accessToken:   stringOrNull,
      channelSecret: stringOrNull,
    }).default({}),

    signal: channelWith({
      cliUrl:      stringOrNull,
      phoneNumber: stringOrNull,
    }).default({}),

    teams: channelWith({
      appId:       stringOrNull,
      appPassword: stringOrNull,
    }).default({}),

    googlechat: channelWith({
      serviceAccount: stringOrNull,
      projectNumber:  stringOrNull,
    }).default({}),
  }).strict().default({}),
}).strict();

/**
 * Validate a raw config object. Returns { ok, data, issues }.
 * Used by `daemora doctor` and startup validation.
 */
export function validateConfig(raw) {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data, issues: [] };
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return { path, message: issue.message };
  });
  return { ok: false, data: null, issues };
}
