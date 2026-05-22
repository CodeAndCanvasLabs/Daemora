/**
 * Email sender — Resend in production, capture-in-memory for tests.
 *
 * Two helpers wrap the common templates so route/auth code never has
 * to know which provider is wired in.
 */

import { Resend } from "resend";

export interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly tag?: string;
}

export interface EmailSender {
  send(email: SentEmail): Promise<void>;
}

/** Resend implementation — used in production. */
export class ResendSender implements EmailSender {
  private readonly client: Resend;
  constructor(private readonly apiKey: string, private readonly from: string) {
    this.client = new Resend(apiKey);
  }
  async send(email: SentEmail): Promise<void> {
    const res = await this.client.emails.send({
      from: this.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      ...(email.tag ? { tags: [{ name: "kind", value: email.tag }] } : {}),
    });
    if (res.error) throw new Error(`Resend send failed: ${res.error.message}`);
  }
}

/** Capture-in-memory implementation for tests — never actually sends. */
export class InMemorySender implements EmailSender {
  readonly sent: SentEmail[] = [];
  async send(email: SentEmail): Promise<void> {
    this.sent.push(email);
  }
  clear(): void { this.sent.length = 0; }
  last(): SentEmail | undefined { return this.sent[this.sent.length - 1]; }
}

// ── templates ─────────────────────────────────────────────────────

export async function sendVerificationEmail(
  sender: EmailSender,
  args: { to: string; url: string },
): Promise<void> {
  await sender.send({
    to: args.to,
    subject: "Verify your daemora email",
    html: verifyTemplate(args.url),
    tag: "email_verification",
  });
}

export async function sendMagicLinkEmail(
  sender: EmailSender,
  args: { to: string; url: string },
): Promise<void> {
  await sender.send({
    to: args.to,
    subject: "Your daemora sign-in link",
    html: magicLinkTemplate(args.url),
    tag: "magic_link",
  });
}

export async function sendTrialReminderEmail(
  sender: EmailSender,
  args: { to: string; daysLeft: number; subscribeUrl: string },
): Promise<void> {
  await sender.send({
    to: args.to,
    subject:
      args.daysLeft <= 0
        ? "Your daemora trial has ended"
        : `Your daemora trial ends in ${args.daysLeft} day${args.daysLeft === 1 ? "" : "s"}`,
    html: trialReminderTemplate(args.daysLeft, args.subscribeUrl),
    tag: "trial_reminder",
  });
}

// ── HTML — kept inline + minimal; no external CSS, no images ──────

function verifyTemplate(url: string): string {
  return `<!doctype html>
<html><body style="font:14px system-ui;padding:24px;max-width:520px;margin:auto">
<h2>Verify your daemora email</h2>
<p>Click the link below to confirm your email and start your 7-day free trial.</p>
<p><a href="${escapeUrl(url)}">${escapeUrl(url)}</a></p>
<p style="color:#888">If you didn't sign up, ignore this email.</p>
</body></html>`;
}

function magicLinkTemplate(url: string): string {
  return `<!doctype html>
<html><body style="font:14px system-ui;padding:24px;max-width:520px;margin:auto">
<h2>Sign in to daemora</h2>
<p>Click the link below to sign in. It expires in 15 minutes.</p>
<p><a href="${escapeUrl(url)}">${escapeUrl(url)}</a></p>
<p style="color:#888">If you didn't request this, ignore — your account is safe.</p>
</body></html>`;
}

function trialReminderTemplate(daysLeft: number, subscribeUrl: string): string {
  const headline = daysLeft <= 0
    ? "Your trial has ended"
    : `Your trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const body = daysLeft <= 0
    ? "Subscribe to keep using daemora. Your data is preserved for 30 days — pick up exactly where you left off."
    : "Subscribe now to continue without interruption.";
  return `<!doctype html>
<html><body style="font:14px system-ui;padding:24px;max-width:520px;margin:auto">
<h2>${headline}</h2>
<p>${body}</p>
<p><a href="${escapeUrl(subscribeUrl)}">${escapeUrl(subscribeUrl)}</a></p>
</body></html>`;
}

function escapeUrl(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
