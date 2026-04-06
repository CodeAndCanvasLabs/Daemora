/**
 * Send Email - sends email via SMTP or Resend (nodemailer).
 *
 * Credential resolution: process.env (RESEND_API_KEY / EMAIL_USER + EMAIL_PASSWORD)
 */

import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";
import egressGuard from "../safety/EgressGuard.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(addr) {
  return EMAIL_REGEX.test(addr.trim());
}

function parseAddressList(val) {
  if (!val) return null;
  return val.split(",").map((a) => a.trim()).filter(Boolean);
}

// Module-level singleton for SMTP - reused across requests for performance.
let _globalTransporter = null;

async function getTransporter() {
  const resendKey  = process.env.RESEND_API_KEY  || null;
  const resendFrom = process.env.RESEND_FROM     || null;
  const smtpUser   = process.env.EMAIL_USER       || null;
  const smtpPass   = process.env.EMAIL_PASSWORD   || null;
  const smtpHost   = process.env.EMAIL_SMTP_HOST || "smtp.gmail.com";
  const smtpPort   = parseInt(process.env.EMAIL_SMTP_PORT || "587", 10);

  if (!resendKey && !smtpUser) return { transporter: null, from: null };

  const nodemailer = await import("nodemailer");

  if (!_globalTransporter) {
    if (resendKey) {
      _globalTransporter = {
        transporter: nodemailer.default.createTransport({
          host: "smtp.resend.com",
          port: 465,
          secure: true,
          auth: { user: "resend", pass: resendKey },
        }),
        from: resendFrom || `daemora@resend.dev`,
      };
    } else {
      _globalTransporter = {
        transporter: nodemailer.default.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: { user: smtpUser, pass: smtpPass },
        }),
        from: smtpUser,
      };
    }
  }
  return _globalTransporter;
}

export async function sendEmail(params) {
  const to = params?.to;
  const subject = params?.subject;
  const body = params?.body;
  if (!to || !subject || !body) {
    return "Error: to, subject, and body are all required.";
  }

  // Merge flat fields with legacy options JSON
  const opts = _mergeLegacyOpts(params, ["to", "subject", "body"]);

  const cc = opts.cc ? parseAddressList(opts.cc) : null;
  const bcc = opts.bcc ? parseAddressList(opts.bcc) : null;
  const replyTo = opts.replyTo || null;
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : null;

  // Validate addresses
  const toList = parseAddressList(to);
  if (!toList || toList.length === 0) return "Error: 'to' must have at least one valid address.";
  for (const addr of toList) {
    if (!validateEmail(addr)) return `Error: Invalid email address: "${addr}"`;
  }
  if (cc) {
    for (const addr of cc) {
      if (!validateEmail(addr)) return `Error: Invalid CC address: "${addr}"`;
    }
  }
  if (bcc) {
    for (const addr of bcc) {
      if (!validateEmail(addr)) return `Error: Invalid BCC address: "${addr}"`;
    }
  }

  console.log(`      [sendEmail] To: ${to} | Subject: "${subject}"${cc ? ` | CC: ${cc.join(",")}` : ""}${bcc ? ` | BCC: ${bcc.join(",")}` : ""}`);

  const { transporter: smtp, from } = await getTransporter();
  if (!smtp) {
    return "Error: Email not configured. Set RESEND_API_KEY or EMAIL_USER+EMAIL_PASSWORD in .env.";
  }

  try {
    const mailOptions = {
      from,
      to: toList.join(", "),
      subject,
      text: body,
      html: body.includes("<") ? body : undefined,
    };

    if (cc) mailOptions.cc = cc.join(", ");
    if (bcc) mailOptions.bcc = bcc.join(", ");
    if (replyTo) mailOptions.replyTo = replyTo;
    if (attachments) {
      mailOptions.attachments = attachments.map((a) => ({
        filename: a.filename,
        path: a.path,
      }));
    }

    // Egress guard - scan email body for leaked secrets
    const bodyCheck = egressGuard.check(mailOptions.text || mailOptions.html || "");
    if (!bodyCheck.safe) {
      return `Error: Email body contains a leaked secret (${bodyCheck.leaked}). Sending blocked.`;
    }

    const info = await smtp.sendMail(mailOptions);

    console.log(`      [sendEmail] Sent: ${info.messageId}`);

    const extra = [];
    if (cc) extra.push(`CC: ${cc.join(", ")}`);
    if (bcc) extra.push(`BCC: ${bcc.join(", ")}`);
    if (attachments) extra.push(`${attachments.length} attachment(s)`);

    return `Email sent to ${to}${extra.length ? ` (${extra.join(", ")})` : ""}. Message ID: ${info.messageId}`;
  } catch (error) {
    console.log(`      [sendEmail] Failed: ${error.message}`);
    return `Failed to send email: ${error.message}`;
  }
}

export const sendEmailDescription =
  'sendEmail(to: string, subject: string, body: string, optionsJson?: string) - Send email. Uses RESEND_API_KEY or EMAIL_USER+EMAIL_PASSWORD from .env. optionsJson: {"cc":"a@b.com","bcc":"e@f.com","replyTo":"r@s.com","attachments":[{"filename":"report.pdf","path":"/tmp/report.pdf"}]}';
