import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import { transcribeAudio } from "../tools/transcribeAudio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";

/**
 * Google Chat Channel - receives messages via Chat App webhook.
 *
 * Setup:
 * 1. Go to https://console.cloud.google.com → New project → Enable "Google Chat API"
 * 2. Under "Google Chat API" → Configuration:
 *    - App name, description, avatar URL (any image)
 *    - Bot URL: https://your-server/webhooks/googlechat
 *    - Check "Receive 1:1 messages" and "Join spaces and group conversations"
 * 3. Create a Service Account (IAM → Service Accounts → Create):
 *    - Download JSON key → copy contents into GOOGLE_CHAT_SERVICE_ACCOUNT env var
 * 4. Set GOOGLE_CHAT_PROJECT_NUMBER (from Google Cloud project settings)
 *
 * Config:
 *   serviceAccount - JSON string of service account key (GOOGLE_CHAT_SERVICE_ACCOUNT)
 *   projectNumber  - Google Cloud project number (GOOGLE_CHAT_PROJECT_NUMBER)
 *   allowlist      - Optional array of Google user IDs / emails allowed to use the bot
 *   model          - Optional model override
 *
 * Unlike OpenClaw's 1000+ LOC implementation with multi-account support,
 * streaming coalescing, and GraphQL-style actions, this keeps it simple:
 * single account, text + file attachments in, text + files out.
 */
export class GoogleChatChannel extends BaseChannel {
  constructor(config) {
    super("googlechat", config);
    this._authClient = null;
  }

  async start() {
    if (!this.config.serviceAccount) {
      console.log(`[Channel:GoogleChat] Skipped - set GOOGLE_CHAT_SERVICE_ACCOUNT`);
      return;
    }

    // Verify auth client initialises without error
    try {
      this._authClient = await this._buildAuthClient();
      this.running = true;
      console.log(`[Channel:GoogleChat] Ready (webhook: POST /webhooks/googlechat)`);
      if (this.config.allowlist?.length) {
        console.log(`[Channel:GoogleChat] Allowlist active - ${this.config.allowlist.length} authorized user(s)`);
      }
    } catch (err) {
      console.log(`[Channel:GoogleChat] Failed to initialise auth: ${err.message}`);
    }
  }

  /**
   * Handle inbound webhook from Google Chat.
   * Called by Express route in index.js.
   * Google Chat expects a JSON response within 30 seconds (synchronous mode).
   */
  async handleWebhook(req, res) {
    // ── Verify the request came from Google Chat ──────────────────────────────
    const valid = await this._verifyRequest(req);
    if (!valid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const event = req.body;
    const type  = event.type;

    // Bot added to a space
    if (type === "ADDED_TO_SPACE") {
      res.json({ text: "Hello! I'm Daemora. Message me and I'll get to work." });
      return;
    }

    if (type !== "MESSAGE") {
      res.json({});
      return;
    }

    const message = event.message;
    const sender  = message?.sender;
    const userId  = sender?.name || sender?.email || "unknown"; // "users/12345..." format
    const userName = sender?.displayName || "User";
    const spaceName = message?.space?.name; // "spaces/AAAA..."
    const msgName   = message?.name;        // "spaces/AAAA.../messages/BBB..." (for threading)

    // Strip @bot mention from text
    const text = (message?.text || "")
      .replace(/<[^>]+>/g, "")   // strip <mention> tags
      .trim();

    const attachments = message?.attachment || [];

    // Allowlist check (match against userId or email)
    const idToCheck = sender?.email || userId;
    if (!this.isAllowed(idToCheck)) {
      res.json({ text: "You are not authorized to use this agent." });
      return;
    }

    // Build input from text + any media attachments
    const inputParts = text ? [text] : [];
    for (const att of attachments) {
      if (!att.attachmentDataRef?.resourceName) continue;
      const localPath = await this._downloadAttachment(att);
      if (!localPath) continue;
      const mimeType = att.contentType || "";
      if (mimeType.startsWith("audio/")) {
        const transcript = await transcribeAudio(localPath);
        inputParts.push(transcript.startsWith("Error:")
          ? `[Audio file: ${localPath}]\n${transcript}`
          : `[Audio transcript]: ${transcript}`);
      } else if (mimeType.startsWith("image/")) {
        inputParts.push(`[Photo received: ${localPath}]${text ? "" : "\nDescribe this image."}`);
      } else if (mimeType.startsWith("video/")) {
        inputParts.push(`[Video received: ${localPath}]`);
      } else {
        inputParts.push(`[File received: ${localPath} (${att.contentName || "attachment"})]`);
      }
    }

    if (inputParts.length === 0) {
      res.json({ text: "Send me a message and I'll get to work." });
      return;
    }

    const input = inputParts.join("\n");
    console.log(`[Channel:GoogleChat] Message from ${userName} (${userId}): "${input.slice(0, 80)}"`);

    // Enqueue and wait - Google Chat allows up to 30s for synchronous reply
    const task = taskQueue.enqueue({
      input,
      channel:     "googlechat",
      channelMeta: { userId, userName, spaceName, msgName, channel: "googlechat" },
      sessionId:   this.getSessionId(userId),
      model:       this.getModel(),
    });

    try {
      const completedTask = await taskQueue.waitForCompletion(task.id);
      if (this.isTaskMerged(completedTask)) { res.json({ text: "" }); return; } // absorbed
      const failed   = completedTask.status === "failed";
      const response = failed
        ? `Sorry, I encountered an error: ${completedTask.error}`
        : completedTask.result || "Done.";

      // Google Chat has a 4000-char message limit; split into multiple API calls if needed
      const chunks = splitMessage(response, 4000);
      if (chunks.length === 1) {
        res.json({ text: chunks[0] });
      } else {
        // First chunk via synchronous response
        res.json({ text: chunks[0] });
        // Remaining chunks sent asynchronously via Chat REST API
        for (let i = 1; i < chunks.length; i++) {
          this._sendMessage(spaceName, chunks[i], msgName).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[Channel:GoogleChat] Error: ${err.message}`);
      res.json({ text: "Sorry, something went wrong. Please try again." });
    }
  }

  async stop() {
    this.running = false;
    console.log(`[Channel:GoogleChat] Stopped`);
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta.spaceName) return;
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      await this._sendMessage(channelMeta.spaceName, chunk).catch(() => {});
    }
  }

  async sendFile(channelMeta, filePath, caption) {
    // Google Chat file upload requires a multipart upload to the media endpoint.
    // For simplicity: send caption + note about the file.
    // Full file upload requires additional Google Chat API scope setup.
    if (caption) await this.sendReply(channelMeta, caption);
    await this.sendReply(channelMeta, `(File: ${filePath})`);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Build a GoogleAuth client with the chat.bot scope.
   */
  async _buildAuthClient() {
    const { GoogleAuth } = await import("google-auth-library");
    const credentials = typeof this.config.serviceAccount === "string"
      ? JSON.parse(this.config.serviceAccount)
      : this.config.serviceAccount;

    const auth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/chat.bot"],
    });
    return auth.getClient();
  }

  /**
   * Get a fresh access token (google-auth-library caches and auto-refreshes it).
   */
  async _getAccessToken() {
    if (!this._authClient) this._authClient = await this._buildAuthClient();
    const token = await this._authClient.getAccessToken();
    return token.token;
  }

  /**
   * Verify that an inbound request actually comes from Google Chat.
   * Google sends an OIDC Bearer token signed by chat@system.gserviceaccount.com.
   * The audience is the PUBLIC_URL of the bot (or project number for simple mode).
   */
  async _verifyRequest(req) {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return false;

    try {
      const { OAuth2Client } = await import("google-auth-library");
      const client = new OAuth2Client();
      // Audience: your public bot URL. Fallback: accept any audience (less secure, good for dev)
      const audience = process.env.PUBLIC_URL || undefined;
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      // Must be issued by Google Chat service account
      return payload?.email === "chat@system.gserviceaccount.com" || !audience;
    } catch {
      // In development without PUBLIC_URL, skip verification and trust the request
      if (!process.env.PUBLIC_URL) {
        console.log(`[Channel:GoogleChat] Warning: set PUBLIC_URL to enable request verification`);
        return true;
      }
      return false;
    }
  }

  /**
   * Send a text message to a Google Chat space via REST API.
   */
  async _sendMessage(spaceName, text, threadName) {
    const token = await this._getAccessToken();
    const url   = `https://chat.googleapis.com/v1/${spaceName}/messages`;
    const body  = { text };
    if (threadName) {
      body.thread = { name: threadName };
    }
    const res = await fetch(url, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15000),
    });
    if (!res.ok) console.log(`[Channel:GoogleChat] sendMessage error: HTTP ${res.status}`);
  }

  /**
   * Download a Google Chat attachment to /tmp.
   * Uses the attachmentDataRef.resourceName with the chat.bot access token.
   */
  async _downloadAttachment(att) {
    try {
      const resourceName = att.attachmentDataRef?.resourceName;
      if (!resourceName) return null;

      const token = await this._getAccessToken();
      const url   = `https://chat.googleapis.com/v1/${resourceName}?alt=media`;
      const res   = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;

      const ext    = _extFromMime(att.contentType || "") || extname(att.contentName || "");
      const tmpDir = join(tmpdir(), "daemora-googlechat");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `att-${Date.now()}${ext}`);
      writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      return filePath;
    } catch (err) {
      console.log(`[Channel:GoogleChat] Attachment download error: ${err.message}`);
      return null;
    }
  }
}

function _extFromMime(mime) {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav",
    "video/mp4": ".mp4", "application/pdf": ".pdf",
  };
  return map[mime] || "";
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n", maxLength);
    if (idx < maxLength * 0.5) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx === -1) idx = maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}
