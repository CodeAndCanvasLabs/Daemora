/**
 * Env loading for apps/api. Fail loud at boot on missing required
 * vars — never silently boot with no DB connection or no MASTER_KEK.
 */

import { z } from "zod";

const Schema = z.object({
  // Postgres
  DATABASE_URL: z.string().url("DATABASE_URL must be a Postgres connection string"),

  // Auth + crypto
  JWT_SIGNING_KEY: z.string().min(43, "JWT_SIGNING_KEY must be at least 32 bytes base64 (~43 chars)"),
  SESSION_COOKIE_SECRET: z.string().min(43),
  MASTER_KEK: z.string().min(43),

  // Inter-service
  CONTROL_PLANE_INTERNAL_URL: z.string().url(),
  CONTROL_PLANE_ADMIN_TOKEN: z.string().min(20),

  // Email
  RESEND_API_KEY: z.string().min(10).optional(),
  RESEND_FROM_EMAIL: z.string().email().default("no-reply@daemora.com"),

  // Contra payment links — strings, not URLs, so tests can use placeholders
  CONTRA_PAYMENT_LINK_LITE: z.string().optional(),
  CONTRA_PAYMENT_LINK_PRO: z.string().optional(),

  // URLs
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),     // UI origin (CORS + post-auth redirect target)
  PUBLIC_API_URL: z.string().url().default("http://localhost:8090"),     // this API's public origin (Better Auth baseURL → links in emails)
  TENANT_HOST_SUFFIX: z.string().default(".daemora.app"),

  // Operational
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | undefined;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment for apps/api:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset cache — for tests only. */
export function resetEnvCache(): void {
  cached = undefined;
}
