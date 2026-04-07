import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import { transcribeAudio } from "../tools/transcribeAudio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { getTenantTmpDir } from "../tools/_paths.js";

/**
 * Microsoft Teams Channel - receives messages via Bot Framework v4 (CloudAdapter).
 *
 * Setup:
 * 1. Go to https://portal.azure.com → Create a resource → Azure Bot
 * 2. Set messaging endpoint to: https://your-server/webhooks/teams
 * 3. Under "Configuration" → copy App ID as TEAMS_APP_ID
 * 4. Under "Configuration" → Manage Password → New client secret → copy as TEAMS_APP_PASSWORD
 * 5. In the bot resource → Channels → Add Microsoft Teams
 *
 * Config:
 *   appId       - Microsoft App ID from Azure Bot registration
 *   appPassword - Client secret from Azure AD app registration
 *   allowlist   - Optional array of Teams user IDs / AAD object IDs
 *   model       - Optional model override
 *
 * Unlike OpenClaw's 461-line channel with Adaptive Cards and Graph API,
 * this is minimal: text messages + file attachments + proactive reply.
 *
 * Teams has a 5-second webhook timeout, so we ack immediately and
 * deliver the agent reply via adapter.continueConversation().
 */
export class TeamsChannel extends BaseChannel {
  constructor(config) {
    super("teams", config);
    this.adapter = null;
    this._conversationRefs = new Map(); // userId → conversationReference
  }

  async start() {
    if (!this.config.appId || !this.config.appPassword) {
      console.log(`[Channel:Teams] Skipped - set TEAMS_APP_ID and TEAMS_APP_PASSWORD`);
      return;
    }

    const {
      CloudAdapter,
      ConfigurationBotFrameworkAuthentication,
      TurnContext,
    } = await import("botbuilder");

    this._TurnContext = TurnContext;

    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.config.appId,
      MicrosoftAppPassword: this.config.appPassword,
    });

    this.adapter = new CloudAdapter(auth);

    this.adapter.onTurnError = async (context, error) => {
      console.error(`[Channel:Teams] Turn error: ${error.message}`);
      try { await context.sendActivity("Sorry, something went wrong. Please try again."); } catch (_) {}
    };

    this.running = true;
    console.log(`[Channel:Teams] Ready (webhook: POST /webhooks/teams)`);
    if (this.config.allowlist?.length) {
      console.log(`[Channel:Teams] Allowlist active - ${this.config.allowlist.length} authorized user(s)`);
    }
  }

  /**
   * Handle inbound webhook from Bot Framework.
   * Called by Express route in index.js.
   * Must respond with HTTP 200 within ~5 seconds, so we ack immediately
   * and deliver the agent reply via proactive messaging.
   */
  async handleWebhook(req, res) {
    if (!this.adapter) {
      res.status(503).json({ error: "Teams channel not started" });
      return;
    }

    await this.adapter.process(req, res, async (context) => {
      const type = context.activity.type;

      // Welcome message when bot is added to a conversation
      if (type === "conversationUpdate") {
        const added = context.activity.membersAdded || [];
        for (const member of added) {
          if (member.id !== context.activity.recipient.id) {
            await context.sendActivity("Hello! I'm Daemora. Send me a message and I'll get to work.");
          }
        }
        return;
      }

      if (type !== "message") return;

      const userId      = context.activity.from?.id || "unknown";
      const userName    = context.activity.from?.name || "User";
      const channelId   = context.activity.channelData?.teamsChannelId || context.activity.conversation?.id;
      const text        = (context.activity.text || "").replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
      const attachments = context.activity.attachments || [];

      // Allowlist check
      if (!this.isAllowed(userId)) {
        await context.sendActivity("You are not authorized to use this agent.");
        return;
      }

      // Build input from text + any file attachments
      const inputParts = text ? [text] : [];
      for (const att of attachments) {
        if (att.contentType === "application/vnd.microsoft.teams.file.download.info") {
          const localPath = await this._downloadAttachment(att);
          if (localPath) {
            const ct = att.contentType || "";
            if (ct.includes("audio")) {
              const transcript = await transcribeAudio(localPath);
              inputParts.push(transcript.startsWith("Error:")
                ? `[Audio file: ${localPath}]\n${transcript}`
                : `[Audio transcript]: ${transcript}`);
            } else {
              inputParts.push(`[File received: ${localPath}]`);
            }
          }
        } else if (att.contentUrl) {
          const ext = _extFromContentType(att.contentType || "");
          const localPath = await this._downloadUrl(att.contentUrl, ext, this.config);
          if (localPath) {
            if ((att.contentType || "").startsWith("image/")) {
              inputParts.push(`[Photo received: ${localPath}]${text ? "" : "\nDescribe this image."}`);
            } else {
              inputParts.push(`[File received: ${localPath} (${att.name || "attachment"})]`);
            }
          }
        }
      }

      if (inputParts.length === 0) {
        await context.sendActivity("Send me a message and I'll get to work.");
        return;
      }

      const input = inputParts.join("\n");
      console.log(`[Channel:Teams] Message from ${userName} (${userId}): "${input.slice(0, 80)}"`);

      // Save conversation reference for proactive reply later
      const ref = this._TurnContext.getConversationReference(context.activity);
      this._conversationRefs.set(userId, ref);

      // Ack with typing indicator - keeps Teams from showing "delivery failed"
      await context.sendActivity({ type: "typing" });

      // Enqueue task and reply proactively (don't await - we must return within 5s)
      const task = taskQueue.enqueue({
        input,
        channel:     "teams",
        channelMeta: { userId, channelId, userName, channel: "teams" },
        sessionId:   this.getSessionId(userId),
        model:       this.getModel(),
      });

      // Fire-and-forget: wait for completion then deliver via continueConversation
      taskQueue.waitForCompletion(task.id)
        .then(async (completedTask) => {
          if (this.isTaskMerged(completedTask)) return; // absorbed into concurrent session
          const failed   = completedTask.status === "failed";
          const response = failed
            ? `Sorry, I encountered an error: ${completedTask.error}`
            : completedTask.result || "Done.";

          await this.adapter.continueConversation(ref, async (proactiveCtx) => {
            const chunks = splitMessage(response, 4000);
            for (const chunk of chunks) {
              await proactiveCtx.sendActivity(chunk);
            }
          });
        })
        .catch((err) => {
          console.error(`[Channel:Teams] Reply error: ${err.message}`);
        });
    });
  }

  async stop() {
    this.running = false;
    this._conversationRefs.clear();
    console.log(`[Channel:Teams] Stopped`);
  }

  async sendReply(channelMeta, text) {
    if (!this.adapter) return;
    const ref = this._conversationRefs.get(channelMeta.userId);
    if (!ref) return;
    try {
      await this.adapter.continueConversation(ref, async (ctx) => {
        const chunks = splitMessage(text, 4000);
        for (const chunk of chunks) { await ctx.sendActivity(chunk); }
      });
    } catch (err) {
      console.log(`[Channel:Teams] sendReply error: ${err.message}`);
    }
  }

  async sendFile(channelMeta, filePath, caption) {
    if (!this.adapter) return;
    const ref = this._conversationRefs.get(channelMeta.userId);
    if (!ref) return;
    try {
      // Teams file sending requires SharePoint upload for larger files.
      // For simplicity: send the file path as text with caption.
      // Full file upload requires Graph API + bot permissions - out of scope here.
      const msg = caption
        ? `${caption}\n(File: ${filePath})`
        : `File: ${filePath}`;
      await this.adapter.continueConversation(ref, async (ctx) => {
        await ctx.sendActivity(msg);
      });
    } catch (err) {
      console.log(`[Channel:Teams] sendFile error: ${err.message}`);
    }
  }

  async _downloadUrl(url, ext, cfg) {
    try {
      const headers = {};
      // Teams content URLs may require the bot credentials for auth
      if (cfg?.appId && cfg?.appPassword) {
        const creds = Buffer.from(`${cfg.appId}:${cfg.appPassword}`).toString("base64");
        headers["Authorization"] = `Basic ${creds}`;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;
      const tmpDir = getTenantTmpDir("teams");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `att-${Date.now()}${ext}`);
      writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
      return filePath;
    } catch { return null; }
  }

  async _downloadAttachment(att) {
    const info = att.content?.downloadUrl;
    if (!info) return null;
    const ext = att.name ? extname(att.name) : "";
    return this._downloadUrl(info, ext, this.config);
  }
}

function _extFromContentType(ct) {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[ct] || "";
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
