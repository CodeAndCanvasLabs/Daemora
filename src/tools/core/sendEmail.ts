import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderUnavailableError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  to: z.string().min(1).describe("Recipient email address(es), comma-separated."),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).describe("Email body (plain text or HTML)."),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  replyTo: z.string().optional(),
  html: z.boolean().default(false).describe("If true, body is treated as HTML."),
});

export function makeSendEmailTool(cfg: ConfigManager): ToolDef<typeof inputSchema, { sent: boolean; to: string }> {
  return {
    name: "send_email",
    description: "Send an email via Resend API. Requires RESEND_API_KEY in vault.",
    category: "channel",
    source: { kind: "core" },
    alwaysOn: false,
    destructive: true,
    tags: ["email", "send", "message"],
    inputSchema,
    async execute({ to, subject, body, cc, bcc, replyTo, html }) {
      const apiKey = cfg.vault.get("RESEND_API_KEY")?.reveal();
      if (!apiKey) throw new ProviderUnavailableError("Email (Resend)", "RESEND_API_KEY");

      const fromAddress = (cfg.settings.getGeneric("RESEND_FROM") as string) ?? "Daemora <daemora@resend.dev>";

      const payload: Record<string, unknown> = {
        from: fromAddress,
        to: to.split(",").map((e) => e.trim()),
        subject,
      };
      if (html) payload.html = body; else payload.text = body;
      if (cc) payload.cc = cc.split(",").map((e) => e.trim());
      if (bcc) payload.bcc = bcc.split(",").map((e) => e.trim());
      if (replyTo) payload.reply_to = replyTo;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Resend API ${res.status}: ${err.slice(0, 200)}`);
      }

      return { sent: true, to };
    },
  };
}
