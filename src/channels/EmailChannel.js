import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Email Channel - polls IMAP for incoming emails, replies via SMTP or Resend.
 *
 * Two setup options (can combine both):
 *
 * OPTION A - Resend (recommended, easiest):
 *   RESEND_API_KEY=re_xxxx          → outbound sending via Resend
 *   RESEND_FROM=you@yourdomain.com  → the "from" address (must be verified in Resend)
 *
 * OPTION B - Gmail IMAP/SMTP (traditional):
 *   EMAIL_USER=you@gmail.com
 *   EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx  ← Gmail App Password (not your real password)
 *   (IMAP/SMTP hosts default to Gmail - no need to set those)
 *
 * For full email agent (receive AND send), combine both or use Gmail IMAP/SMTP.
 * Resend only handles outbound - you still need EMAIL_USER+PASSWORD for IMAP inbox polling.
 */
export class EmailChannel extends BaseChannel {
  constructor(config) {
    super("email", config);
    this.transporter = null;
    this.fromAddress = null;
    this.pollTimer = null;
    this.processedIds = new Set();
  }

  async start() {
    const hasResend  = !!this.config.resendApiKey;
    const hasSmtp    = !!(this.config.user && this.config.password);
    const hasInbound = hasSmtp;  // IMAP requires EMAIL_USER + EMAIL_PASSWORD

    if (!hasResend && !hasSmtp) {
      console.log(`[Channel:Email] Skipped - set RESEND_API_KEY or EMAIL_USER+EMAIL_PASSWORD`);
      return;
    }

    const nodemailer = await import("nodemailer");

    // ── Outbound transport ────────────────────────────────────────────────────
    if (hasResend) {
      // Resend SMTP relay - no extra package needed, just nodemailer
      this.transporter = nodemailer.default.createTransport({
        host: "smtp.resend.com",
        port: 465,
        secure: true,
        auth: { user: "resend", pass: this.config.resendApiKey },
      });
      this.fromAddress = this.config.resendFrom || `daemora@resend.dev`;
      console.log(`[Channel:Email] Outbound: Resend (from: ${this.fromAddress})`);
    } else {
      // Traditional SMTP (Gmail, etc.)
      this.transporter = nodemailer.default.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.port === 465,
        auth: { user: this.config.user, pass: this.config.password },
      });
      this.fromAddress = this.config.user;
      console.log(`[Channel:Email] Outbound: SMTP (${this.config.smtp.host})`);
    }

    // ── Inbound polling (IMAP) ────────────────────────────────────────────────
    if (hasInbound) {
      this.running = true;
      this.pollTimer = setInterval(() => this.pollEmails(), 60000);
      console.log(`[Channel:Email] Inbound: IMAP polling every 60s (${this.config.user})`);
      this.pollEmails();
    } else {
      console.log(`[Channel:Email] Inbound: disabled (set EMAIL_USER+EMAIL_PASSWORD to enable IMAP polling)`);
    }
  }

  async stop() {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`[Channel:Email] Stopped`);
  }

  async pollEmails() {
    try {
      const Imap = (await import("imap")).default;

      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.imap.host,
        port: this.config.imap.port,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      });

      await new Promise((resolve, reject) => {
        imap.once("ready", () => {
          imap.openBox("INBOX", false, (err) => {
            if (err) { reject(err); return; }

            // Search for unseen emails
            imap.search(["UNSEEN"], (err, results) => {
              if (err) { imap.end(); reject(err); return; }
              if (!results || results.length === 0) { imap.end(); resolve(); return; }

              console.log(`[Channel:Email] Found ${results.length} new email(s)`);

              const fetch = imap.fetch(results, { bodies: "", markSeen: true });

              fetch.on("message", (msg) => {
                let body = "";
                let headers = {};

                msg.on("body", (stream) => {
                  stream.on("data", (chunk) => { body += chunk.toString(); });
                });

                msg.once("attributes", (attrs) => {
                  headers = attrs;
                });

                msg.once("end", () => {
                  this.processEmail(body, headers);
                });
              });

              fetch.once("end", () => { imap.end(); resolve(); });
              fetch.once("error", (err) => { imap.end(); reject(err); });
            });
          });
        });

        imap.once("error", reject);
        imap.connect();
      });
    } catch (error) {
      console.log(`[Channel:Email] Poll error: ${error.message}`);
    }
  }

  async processEmail(rawEmail, attrs) {
    try {
      // Simple header parsing
      const fromMatch = rawEmail.match(/^From:\s*(.+)$/mi);
      const subjectMatch = rawEmail.match(/^Subject:\s*(.+)$/mi);
      const from = fromMatch ? fromMatch[1].trim() : "unknown";
      const subject = subjectMatch ? subjectMatch[1].trim() : "(no subject)";

      // Extract email address from "Name <email>" format
      const emailMatch = from.match(/<([^>]+)>/);
      const senderEmail = emailMatch ? emailMatch[1] : from;

      // Extract body (simplified - takes text after headers)
      const bodyStart = rawEmail.indexOf("\r\n\r\n");
      const emailBody = bodyStart > -1 ? rawEmail.slice(bodyStart + 4).trim() : rawEmail;

      // Skip if already processed
      const uid = `${senderEmail}-${subject}-${attrs?.uid || Date.now()}`;
      if (this.processedIds.has(uid)) return;
      this.processedIds.add(uid);

      console.log(`[Channel:Email] Processing: from=${senderEmail} subject="${subject}"`);

      const taskInput = `Email from: ${senderEmail}\nSubject: ${subject}\n\nBody:\n${emailBody.slice(0, 5000)}`;

      const task = taskQueue.enqueue({
        input: taskInput,
        channel: "email",
        channelMeta: { senderEmail, subject },
        sessionId: this.getSessionId(senderEmail),
      });

      // Wait and reply
      const completedTask = await taskQueue.waitForCompletion(task.id);
      if (this.isTaskMerged(completedTask)) return; // absorbed into concurrent session
      const response = completedTask.status === "failed"
        ? `Sorry, I encountered an error processing your request: ${completedTask.error}`
        : completedTask.result || "Done.";

      await this.sendReply({ senderEmail, subject }, response);
    } catch (error) {
      console.log(`[Channel:Email] Process error: ${error.message}`);
    }
  }

  async sendReply(channelMeta, text) {
    if (!this.transporter) return;

    await this.transporter.sendMail({
      from: this.fromAddress,
      to: channelMeta.senderEmail,
      subject: `Re: ${channelMeta.subject}`,
      text: text,
    });

    console.log(`[Channel:Email] Reply sent to ${channelMeta.senderEmail}`);
  }
}
