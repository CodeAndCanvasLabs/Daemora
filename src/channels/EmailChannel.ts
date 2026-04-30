/**
 * EmailChannel — IMAP inbound + SMTP outbound email bot.
 *
 * Receive path:
 *   • imapflow polls an IMAP folder (default INBOX) every `pollInterval`
 *     ms looking for UNSEEN messages.
 *   • For each message we fetch the envelope (parsed headers) and the
 *     text body, build an IncomingMessage, and hand it to the channel
 *     manager's onMessage callback. No external MIME parser needed —
 *     imapflow does the heavy lifting.
 *
 * Send path:
 *   • Resend SMTP relay if RESEND_API_KEY is configured, otherwise a
 *     standard nodemailer transport against the IMAP account's SMTP
 *     server (Gmail by default).
 *
 * This matches the JS EmailChannel capability surface (inbound polling
 * + outbound via Resend or SMTP) with the modern imapflow API and
 * async/await all the way through.
 */

import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("channel.email");

export interface EmailChannelOpts {
  readonly onMessage: (msg: IncomingMessage) => void;
  /** IMAP / SMTP login username (usually the email address). */
  readonly user: string;
  /** IMAP / SMTP password. Gmail requires an app password. */
  readonly password: string;
  /** IMAP host. Defaults to Gmail. */
  readonly imapHost?: string;
  readonly imapPort?: number;
  /** SMTP host. Defaults to Gmail. */
  readonly smtpHost?: string;
  readonly smtpPort?: number;
  /** IMAP mailbox to watch. Defaults to INBOX. */
  readonly mailbox?: string;
  /** Poll cadence in ms. Defaults to 60 s. */
  readonly pollInterval?: number;
  /**
   * Resend API key — when set, outbound goes via Resend's SMTP relay
   * and `user`/`password` are only used for inbound IMAP.
   */
  readonly resendApiKey?: string;
  readonly resendFrom?: string;
  /** Restrict inbound to specific sender addresses. */
  readonly allowedSenders?: readonly string[];
}

interface NodeMailerTransport {
  sendMail: (opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }) => Promise<unknown>;
  close: () => void;
}

interface ImapFlowClient {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  mailboxOpen: (name: string) => Promise<unknown>;
  mailboxClose: () => Promise<unknown>;
  search: (criteria: Record<string, unknown>) => Promise<number[]>;
  fetch: (range: number[] | string, options: Record<string, unknown>) => AsyncIterable<{
    uid: number;
    envelope?: {
      messageId?: string;
      from?: { name?: string; address?: string }[];
      to?: { address?: string }[];
      subject?: string;
      date?: Date;
    };
    source?: Buffer;
  }>;
  messageFlagsAdd: (range: number[] | string, flags: string[]) => Promise<unknown>;
}

export class EmailChannel extends BaseChannel {
  readonly id = "email" as const;
  readonly name = "Email" as const;
  override readonly supportsFiles = true;

  private readonly opts: Required<Omit<EmailChannelOpts, "resendApiKey" | "resendFrom" | "allowedSenders">> & {
    resendApiKey: string | undefined;
    resendFrom: string | undefined;
    allowedSenders: ReadonlySet<string>;
  };

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private transport: NodeMailerTransport | null = null;
  private fromAddress: string | null = null;
  private polling = false;

  constructor(opts: EmailChannelOpts) {
    super();
    this.opts = {
      onMessage: opts.onMessage,
      user: opts.user,
      password: opts.password,
      imapHost: opts.imapHost ?? "imap.gmail.com",
      imapPort: opts.imapPort ?? 993,
      smtpHost: opts.smtpHost ?? "smtp.gmail.com",
      smtpPort: opts.smtpPort ?? 465,
      mailbox: opts.mailbox ?? "INBOX",
      pollInterval: opts.pollInterval ?? 60_000,
      resendApiKey: opts.resendApiKey,
      resendFrom: opts.resendFrom,
      allowedSenders: new Set((opts.allowedSenders ?? []).map((a) => a.toLowerCase())),
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    const nodemailerMod = await import("nodemailer");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodemailer = (nodemailerMod as any).default ?? nodemailerMod;

    if (this.opts.resendApiKey) {
      this.transport = nodemailer.createTransport({
        host: "smtp.resend.com",
        port: 465,
        secure: true,
        auth: { user: "resend", pass: this.opts.resendApiKey },
      }) as NodeMailerTransport;
      this.fromAddress = this.opts.resendFrom ?? "daemora@resend.dev";
      log.info({ from: this.fromAddress }, "email outbound: resend");
    } else {
      this.transport = nodemailer.createTransport({
        host: this.opts.smtpHost,
        port: this.opts.smtpPort,
        secure: this.opts.smtpPort === 465,
        auth: { user: this.opts.user, pass: this.opts.password },
      }) as NodeMailerTransport;
      this.fromAddress = this.opts.user;
      log.info({ host: this.opts.smtpHost, from: this.fromAddress }, "email outbound: smtp");
    }

    // Inbound polling starts immediately and repeats every pollInterval.
    this.polling = true;
    this.pollTimer = setInterval(() => void this.pollInbox(), this.opts.pollInterval);
    void this.pollInbox();
    log.info(
      { host: this.opts.imapHost, mailbox: this.opts.mailbox, intervalMs: this.opts.pollInterval },
      "email inbound: IMAP polling started",
    );
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.transport?.close();
    this.transport = null;
    log.info("email channel stopped");
  }

  // ── Outbound ────────────────────────────────────────────────────

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    if (!this.transport || !this.fromAddress) {
      throw new Error("Email transport not initialised");
    }
    const to = (meta.senderEmail as string | undefined) ?? (meta.to as string | undefined) ?? (meta.email as string | undefined);
    if (!to) throw new Error("Email reply needs senderEmail / to / email in channelMeta");
    const subject = (meta.subject as string | undefined) ?? "(no subject)";
    await this.transport.sendMail({
      from: this.fromAddress,
      to,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      text,
    });
    log.info({ to }, "email reply sent");
  }

  override async sendFile(meta: ChannelMeta, filePath: string, caption?: string): Promise<void> {
    if (!this.transport || !this.fromAddress) {
      throw new Error("Email transport not initialised");
    }
    const to = (meta.senderEmail as string | undefined) ?? (meta.to as string | undefined) ?? (meta.email as string | undefined);
    if (!to) throw new Error("Email file send needs senderEmail / to / email in channelMeta");
    const subject = (meta.subject as string | undefined) ?? "File from Daemora";
    await this.transport.sendMail({
      from: this.fromAddress,
      to,
      subject,
      text: caption ?? "",
      // nodemailer supports attachments via the same sendMail call;
      // we extend the call site rather than the typed interface.
      ...{ attachments: [{ path: filePath }] },
    } as unknown as { from: string; to: string; subject: string; text: string });
  }

  override isAllowed(userId: string): boolean {
    if (this.opts.allowedSenders.size === 0) return true;
    return this.opts.allowedSenders.has(userId.toLowerCase());
  }

  // ── Inbound polling ──────────────────────────────────────────────

  private async pollInbox(): Promise<void> {
    if (!this.polling) return;

    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: this.opts.imapHost,
      port: this.opts.imapPort,
      secure: true,
      auth: { user: this.opts.user, pass: this.opts.password },
      logger: false,
    }) as unknown as ImapFlowClient;

    try {
      await client.connect();
      await client.mailboxOpen(this.opts.mailbox);

      const uids = await client.search({ seen: false });
      if (!uids || uids.length === 0) {
        await client.logout();
        return;
      }
      log.info({ count: uids.length }, "email: unseen messages");

      for await (const msg of client.fetch(uids, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? "";
        if (fromAddr && !this.isAllowed(fromAddr)) {
          log.debug({ from: fromAddr }, "email: sender not in allowlist, skipping");
          continue;
        }

        const subject = msg.envelope?.subject ?? "(no subject)";
        const messageId = msg.envelope?.messageId ?? String(msg.uid);
        const body = msg.source ? extractPlainBody(msg.source.toString("utf-8")) : "";

        const incoming: IncomingMessage = {
          channel: this.id,
          userId: fromAddr || "unknown",
          text: `Email from ${fromAddr || "unknown"}\nSubject: ${subject}\n\n${body.slice(0, 5000)}`,
          meta: {
            channel: this.id,
            userId: fromAddr,
            chatId: fromAddr,
            messageId,
            senderEmail: fromAddr,
            email: fromAddr,
            subject,
            uid: msg.uid,
          },
          timestamp: msg.envelope?.date?.getTime() ?? Date.now(),
        };

        try {
          this.opts.onMessage(incoming);
        } catch (e) {
          log.error({ err: (e as Error).message }, "email onMessage handler failed");
        }
      }

      await client.messageFlagsAdd(uids, ["\\Seen"]);
      await client.mailboxClose();
      await client.logout();
    } catch (e) {
      log.error({ err: (e as Error).message }, "email poll error");
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
}

/**
 * Minimal MIME-ish body extractor: strips headers (everything up to
 * the first blank line), pulls the text/plain part out of a simple
 * multipart envelope if present, and leaves the decoded text alone.
 * Not a full parser — covers the 90% case we see from real inboxes.
 */
function extractPlainBody(raw: string): string {
  const headersEnd = raw.indexOf("\r\n\r\n");
  const afterHeaders = headersEnd >= 0 ? raw.slice(headersEnd + 4) : raw;

  // Handle the common multipart/alternative layout.
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (boundaryMatch?.[1]) {
    const boundary = `--${boundaryMatch[1]}`;
    const parts = afterHeaders.split(boundary);
    for (const part of parts) {
      if (/content-type:\s*text\/plain/i.test(part)) {
        const bodyStart = part.indexOf("\r\n\r\n");
        if (bodyStart >= 0) {
          return part.slice(bodyStart + 4).trim();
        }
      }
    }
  }
  return afterHeaders.trim();
}
