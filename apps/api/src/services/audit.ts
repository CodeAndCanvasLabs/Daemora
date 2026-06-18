/**
 * Audit logger — writes one row per security-relevant action.
 * Never throws; logging must not break the auth flow.
 */

import { type DB } from "../db/client.js";
import { auditLog } from "../db/schema.js";

export type AuditKind =
  | "signup"
  | "signin"
  | "signout"
  | "verify_email"
  | "magic_link_sent"
  | "magic_link_used"
  | "password_changed"
  | "trial_started"
  | "trial_expired"
  | "plan_changed"
  | "claim_filed"
  | "claim_confirmed"
  | "claim_rejected"
  | "admin_action"
  | "rate_limited";

export interface AuditEvent {
  readonly kind: AuditKind;
  readonly userId?: string | null;
  readonly detail?: Record<string, unknown>;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export class AuditLogger {
  constructor(private readonly db: DB) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        kind: event.kind,
        userId: event.userId ?? null,
        detail: event.detail ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
      });
    } catch (err) {
      // Audit failure must never break the request. Log and move on.
      // eslint-disable-next-line no-console
      console.error("[audit] failed to write event", event.kind, (err as Error).message);
    }
  }
}

/** Extract IP + UA from a Hono context's raw request. */
export function clientFingerprint(req: Request): { ipAddress: string | null; userAgent: string | null } {
  const h = req.headers;
  // Trust X-Forwarded-For only when behind Fly's proxy (it sets it).
  const xff = h.get("fly-client-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: xff ?? null,
    userAgent: h.get("user-agent") ?? null,
  };
}
