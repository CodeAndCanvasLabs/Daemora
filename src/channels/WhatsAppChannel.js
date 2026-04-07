import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import { transcribeAudio } from "../tools/transcribeAudio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { getTenantTmpDir } from "../tools/_paths.js";

/**
 * WhatsApp Channel - receives messages via Twilio webhook.
 *
 * Setup:
 * 1. Create Twilio account + WhatsApp sandbox
 * 2. Set webhook URL to: https://your-server/webhooks/whatsapp
 * 3. Set env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *
 * Config:
 *   accountSid - Twilio account SID
 *   authToken  - Twilio auth token
 *   from       - Your WhatsApp number (whatsapp:+14155238886)
 *   allowlist  - Optional array of phone numbers (+1234567890) allowed to send tasks
 *   model      - Optional model override
 */
export class WhatsAppChannel extends BaseChannel {
  constructor(config) {
    super("whatsapp", config);
    this.twilioClient = null;
  }

  async start() {
    if (!this.config.accountSid || !this.config.authToken) {
      console.log(`[Channel:WhatsApp] Skipped - no Twilio credentials`);
      return;
    }

    const twilio = await import("twilio");
    this.twilioClient = twilio.default(this.config.accountSid, this.config.authToken);
    this.running = true;
    console.log(`[Channel:WhatsApp] Ready (webhook: POST /webhooks/whatsapp)`);

    // Auto-configure Twilio sandbox webhook URL if tunnel is available
    this._autoConfigureWebhook();
    if (this.config.allowlist?.length) {
      console.log(`[Channel:WhatsApp] Allowlist active - ${this.config.allowlist.length} authorized number(s)`);
    }
  }

  /**
   * Auto-configure Twilio WhatsApp sandbox webhook URL.
   * Waits for DAEMORA_PUBLIC_URL (set by tunnel) then updates Twilio sandbox.
   */
  async _autoConfigureWebhook() {
    // Wait up to 30s for tunnel URL to be available
    let publicUrl = null;
    for (let i = 0; i < 30; i++) {
      publicUrl = process.env.DAEMORA_PUBLIC_URL || process.env.SERVER_URL;
      if (publicUrl) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!publicUrl) return;

    const webhookUrl = `${publicUrl}/webhooks/whatsapp`;
    try {
      // Update sandbox webhook via Twilio API
      const sandboxes = await this.twilioClient.messaging.v1.services.list({ limit: 1 });
      if (sandboxes.length > 0) {
        // Try sandbox configuration
        await this.twilioClient.messaging.v1.services(sandboxes[0].sid).update({
          inboundRequestUrl: webhookUrl,
        });
        console.log(`[Channel:WhatsApp] Webhook auto-configured: ${webhookUrl}`);
        return;
      }
    } catch {}

    // Fallback: try phone number webhook update
    try {
      const from = this.config.from?.replace("whatsapp:", "") || "";
      if (from) {
        const numbers = await this.twilioClient.incomingPhoneNumbers.list({ phoneNumber: from });
        if (numbers.length > 0) {
          await this.twilioClient.incomingPhoneNumbers(numbers[0].sid).update({
            smsUrl: webhookUrl,
            smsMethod: "POST",
          });
          console.log(`[Channel:WhatsApp] Webhook auto-configured on ${from}: ${webhookUrl}`);
          return;
        }
      }
    } catch {}

    console.log(`[Channel:WhatsApp] Auto-webhook skipped - set manually in Twilio Console: ${webhookUrl}`);
  }

  async stop() {
    this.running = false;
    console.log(`[Channel:WhatsApp] Stopped`);
  }

  /**
   * Handle incoming webhook from Twilio.
   * Called by Express route in index.js.
   */
  async handleWebhook(body) {
    const from   = body.From; // whatsapp:+1234567890
    const text   = body.Body || "";
    const phone  = from.replace("whatsapp:", "");
    const numMedia = parseInt(body.NumMedia || "0", 10);

    console.log(`[Channel:WhatsApp] Message from ${phone}: "${text?.slice(0, 80)}"${numMedia ? ` + ${numMedia} media` : ""}`);

    if (!text && numMedia === 0) return null;

    // Allowlist check (match against the phone number without "whatsapp:" prefix)
    if (!this.isAllowed(phone)) {
      console.log(`[Channel:WhatsApp] Blocked (not in allowlist): ${phone}`);
      await this.sendReply({ phone, from }, "You are not authorized to use this agent.");
      return "blocked";
    }

    // Build input from text + media attachments
    const inputParts = text ? [text] : [];
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl  = body[`MediaUrl${i}`];
      const mediaType = body[`MediaContentType${i}`] || "";
      if (!mediaUrl) continue;

      const localPath = await this._downloadMedia(mediaUrl, mediaType);
      if (!localPath) continue;

      if (mediaType.startsWith("audio/")) {
        console.log(`[Channel:WhatsApp] Audio media - transcribing...`);
        const transcript = await transcribeAudio({ audioPath: localPath });
        inputParts.push(transcript.startsWith("Error:")
          ? `[Audio file: ${localPath}]\n${transcript}`
          : `[Voice/Audio transcript]: ${transcript}`);
      } else if (mediaType.startsWith("image/")) {
        inputParts.push(`[Photo received: ${localPath}]\nUser caption: ${text || "Describe and respond to this image."}`);
      } else if (mediaType.startsWith("video/")) {
        inputParts.push(`[Video received: ${localPath}]`);
      } else {
        inputParts.push(`[File received: ${localPath}]`);
      }
    }

    const input = inputParts.join("\n");

    // Create task
    const task = taskQueue.enqueue({
      input,
      channel: "whatsapp",
      channelMeta: { phone, from, userName: from || phone, channel: "whatsapp" },
      sessionId: this.getSessionId(phone),
      model: this.getModel(),
    });

    // Wait for completion
    const completedTask = await taskQueue.waitForCompletion(task.id);

    // Absorbed into a concurrent session - response already sent via original task
    if (this.isTaskMerged(completedTask)) return;

    // Send reply via Twilio
    const response = completedTask.status === "failed"
      ? `Sorry, I encountered an error: ${completedTask.error}`
      : completedTask.result || "Done.";

    await this.sendReply({ phone, from }, response);
    return response;
  }

  async sendReply(channelMeta, text) {
    if (!this.twilioClient) return;

    // WhatsApp message limit: ~1600 chars. Split if needed.
    const chunks = splitText(text, 1600);
    for (const chunk of chunks) {
      await this.twilioClient.messages.create({
        from: this.config.from,
        to: channelMeta.from,
        body: chunk,
      });
    }
  }

  /**
   * Send a media file to a WhatsApp number via Twilio.
   * Requires a publicly accessible URL for the media.
   * If PUBLIC_URL is configured, the file is served from the local HTTP server.
   * Otherwise, this is a no-op with an informative log.
   */
  async sendFile(channelMeta, filePath, caption) {
    if (!this.twilioClient) return;

    const publicUrl = process.env.PUBLIC_URL;
    if (!publicUrl) {
      console.log(`[Channel:WhatsApp] sendFile: set PUBLIC_URL env var to serve media files`);
      // Fall back to sending just a text notice
      if (caption) await this.sendReply(channelMeta, caption);
      return;
    }

    try {
      const fileName = basename(filePath);
      const mediaUrl = `${publicUrl.replace(/\/$/, "")}/media/${fileName}`;

      await this.twilioClient.messages.create({
        from: this.config.from,
        to: channelMeta.from,
        mediaUrl: [mediaUrl],
        body: caption || undefined,
      });
    } catch (err) {
      console.log(`[Channel:WhatsApp] sendFile error: ${err.message}`);
    }
  }

  /**
   * Download Twilio media to /tmp using Basic auth (accountSid:authToken).
   */
  async _downloadMedia(mediaUrl, contentType) {
    try {
      const ext = _mimeToExt(contentType) || "";
      const tmpDir  = getTenantTmpDir("whatsapp");
      mkdirSync(tmpDir, { recursive: true });
      const fileName = `media-${Date.now()}${ext}`;
      const filePath = join(tmpDir, fileName);

      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
      const res  = await fetch(mediaUrl, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      writeFileSync(filePath, Buffer.from(buffer));
      return filePath;
    } catch (err) {
      console.log(`[Channel:WhatsApp] Media download error: ${err.message}`);
      return null;
    }
  }
}

function _mimeToExt(mimeType) {
  const map = {
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "audio/wav": ".wav", "audio/webm": ".webm",
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/3gpp": ".3gp", "video/quicktime": ".mov",
    "application/pdf": ".pdf",
  };
  return map[mimeType] || "";
}

function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n", maxLength);
    if (idx < maxLength * 0.3) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx === -1) idx = maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}
