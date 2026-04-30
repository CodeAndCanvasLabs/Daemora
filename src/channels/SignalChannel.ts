/**
 * SignalChannel — relays Signal messages through a signal-cli daemon.
 *
 * signal-cli is an external binary (https://github.com/AsamK/signal-cli)
 * that handles the Signal protocol. This channel polls its REST daemon
 * every 2 s for new messages and sends replies via POST /v2/send.
 *
 * Setup:
 *   1. Install signal-cli.
 *   2. Register + verify your phone number.
 *   3. Start the daemon:  signal-cli -u +1234567890 daemon --http 127.0.0.1:8080
 *   4. Provide SIGNAL_CLI_URL and SIGNAL_PHONE_NUMBER.
 */

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.signal");

const POLL_INTERVAL_MS = 2_000;
const DEDUP_WINDOW_MS = 30_000;

export interface SignalChannelOpts {
  readonly cliUrl: string;
  readonly phoneNumber: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

interface SignalEnvelope {
  envelope?: {
    source?: string;
    dataMessage?: {
      message?: string;
      timestamp?: number;
    };
  };
}

export class SignalChannel extends BaseChannel {
  readonly id = "signal" as const;
  readonly name = "Signal" as const;

  private readonly cliUrl: string;
  private readonly phoneNumber: string;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly inflight = new Set<string>();

  constructor(opts: SignalChannelOpts) {
    super();
    this.cliUrl = opts.cliUrl.replace(/\/$/, "");
    this.phoneNumber = opts.phoneNumber;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    try {
      const res = await fetch(`${this.cliUrl}/v1/health`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`signal-cli /v1/health ${res.status}`);
    } catch (e) {
      log.error({ err: (e as Error).message, cliUrl: this.cliUrl },
        "cannot reach signal-cli daemon — start with `signal-cli -u <number> daemon --http ...`");
      return;
    }

    this.running = true;
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_INTERVAL_MS);
    log.info({ cliUrl: this.cliUrl, phoneNumber: this.phoneNumber }, "signal polling started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("signal channel stopped");
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const recipient = (meta.sender as string | undefined) ?? (meta.chatId as string | undefined);
    if (!recipient) throw new Error("Signal reply needs sender in channelMeta");

    for (const chunk of splitMessage(text, 3000)) {
      const res = await fetch(`${this.cliUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          number: this.phoneNumber,
          recipients: [recipient],
          message: chunk,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error({ status: res.status, body }, "signal send failed");
      }
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  // ── Polling ─────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch(
        `${this.cliUrl}/v1/receive/${encodeURIComponent(this.phoneNumber)}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return;
      const messages = (await res.json()) as SignalEnvelope[];
      if (!Array.isArray(messages) || messages.length === 0) return;
      for (const env of messages) this.handleEnvelope(env);
    } catch {
      // Expected — signal-cli might be restarting. Stay quiet in logs.
    }
  }

  private handleEnvelope(env: SignalEnvelope): void {
    const data = env.envelope?.dataMessage;
    if (!data) return;
    const text = data.message?.trim();
    const sender = env.envelope?.source;
    const timestamp = data.timestamp ?? Date.now();
    if (!text || !sender) return;

    const dedupKey = `${sender}:${timestamp}`;
    if (this.inflight.has(dedupKey)) return;
    this.inflight.add(dedupKey);
    setTimeout(() => this.inflight.delete(dedupKey), DEDUP_WINDOW_MS).unref();

    if (!this.isAllowed(sender)) {
      log.info({ sender }, "signal: sender not in allowlist");
      void this.sendReply({ channel: this.id, userId: sender, sender }, "You are not authorized to use this agent.");
      return;
    }

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: sender,
      text,
      meta: {
        channel: this.id,
        userId: sender,
        sender,
        chatId: sender,
        messageId: String(timestamp),
      },
      timestamp,
    };
    this.onMessage(incoming);
  }
}

/**
 * Split a long message on whitespace / newline boundaries so each
 * Signal send stays under its size cap without mid-word cuts.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n", maxLength);
    if (idx < maxLength * 0.5) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx === -1) idx = maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}
