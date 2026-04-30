/**
 * BaseChannel — abstract base class all channel implementations extend.
 *
 * Each channel bridges an external messaging platform (Telegram, Slack,
 * Discord, etc.) into Daemora's task system. Subclasses implement the
 * abstract methods; optional hooks have default no-ops so channels only
 * override what they support.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface ChannelMeta {
  channel: string;
  userId: string;
  chatId?: string;
  messageId?: string;
  threadId?: string;
  [key: string]: unknown;
}

/**
 * An attachment a user sent with (or instead of) their text. Channels
 * normalise their platform payloads into this shape so the agent can
 * treat files uniformly. Either `url` (remote, must be downloadable by
 * the agent runtime) or `path` (already on the local filesystem — used
 * by the HTTP uploader) is always set; `mimeType` is used to decide
 * whether to inline as an image, transcribe as audio, or extract text.
 */
export interface InboundAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "file";
  readonly url?: string;
  readonly path?: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly size?: number;
  /**
   * Optional authorisation header value needed to fetch `url`
   * (Telegram bot token, Slack bearer, etc.). Channels that expose
   * unauthenticated URLs leave this undefined.
   */
  readonly authHeader?: string;
}

export interface IncomingMessage {
  channel: string;
  userId: string;
  text: string;
  meta: ChannelMeta;
  timestamp: number;
  /** Files the user attached. Absent/empty = plain text message. */
  attachments?: readonly InboundAttachment[];
}

// ── Base class ────────────────────────────────────────────────────

export abstract class BaseChannel {
  /** Unique channel identifier (e.g. "telegram", "discord"). */
  abstract readonly id: string;

  /** Human-readable display name. */
  abstract readonly name: string;

  /**
   * Whether this channel can deliver streaming text by editing a message
   * in place. Channels that override this to `true` must also implement
   * `editMessage()` so the streaming loop can update the draft.
   */
  readonly supportsStreaming: boolean = false;

  /**
   * Hard message length cap. Streams that exceed this get chunked
   * via `splitMessage()` instead of edited in place.
   */
  readonly maxMessageLength: number = 4000;

  /** Start receiving messages (webhook, long-poll, or WS). */
  abstract start(): Promise<void>;

  /** Gracefully stop the channel and release resources. */
  abstract stop(): Promise<void>;

  /** Send a text reply back to the originating conversation. */
  abstract sendReply(meta: ChannelMeta, text: string): Promise<void>;

  /**
   * Whether this channel can upload local files. Subclasses that
   * override `sendFile()` should also flip this to `true` so the
   * `send_file` tool can short-circuit with a clear error when the
   * active channel doesn't support uploads.
   */
  readonly supportsFiles: boolean = false;

  /**
   * First-send-or-edit for streaming. The returned `messageId` is passed
   * back on subsequent calls so we edit in place. Default implementation:
   * call sendReply every time (no streaming) — override for real support.
   */
  async sendOrEditStream(
    meta: ChannelMeta,
    text: string,
    prevMessageId: string | null,
  ): Promise<string | null> {
    if (prevMessageId && this.supportsStreaming) {
      await this.editMessage(meta, prevMessageId, text);
      return prevMessageId;
    }
    await this.sendReply(meta, text);
    return null;
  }

  // ── Optional overrides (default no-ops) ───────────────────────

  /** Send a typing indicator. */
  async sendTyping(_meta: ChannelMeta): Promise<void> {}

  /** React with an emoji on a message. */
  async sendReaction(_meta: ChannelMeta, _emoji: string): Promise<void> {}

  /** Edit a previously-sent message. */
  async editMessage(_meta: ChannelMeta, _messageId: string, _text: string): Promise<void> {}

  /** Delete a previously-sent message. */
  async deleteMessage(_meta: ChannelMeta, _messageId: string): Promise<void> {}

  /**
   * Create a poll in the current chat. Channels that don't support
   * polls (Slack threads, Line, generic webhooks) leave this default
   * implementation in place — the `poll` tool turns the fallback into
   * a clear "channel doesn't support polls" error.
   */
  async sendPoll(
    _meta: ChannelMeta,
    _question: string,
    _options: readonly string[],
    _durationHours?: number,
  ): Promise<void> {
    throw new Error(`Channel '${this.id}' does not support polls`);
  }

  /**
   * Upload a local file to the chat. Channels that support file
   * attachments (Telegram, Discord, Slack, WhatsApp via Twilio media
   * URL, email) override this; other channels leave the default
   * "not supported" throw in place and the `send_file` tool surfaces a
   * clean error.
   */
  async sendFile(
    _meta: ChannelMeta,
    _filePath: string,
    _caption?: string,
  ): Promise<void> {
    throw new Error(`Channel '${this.id}' does not support file uploads`);
  }

  // ── Config helpers ────────────────────────────────────────────

  /** Override to route this channel to a specific model. */
  getModel(): string | null {
    return null;
  }

  /** Session key for this user on this channel. */
  getSessionId(userId: string): string {
    return `${this.id}:${userId}`;
  }

  /** Override to enforce allowlists / blocklists. */
  isAllowed(_userId: string): boolean {
    return true;
  }

  // ── Webhook channels ──────────────────────────────────────────

  /**
   * If this channel receives messages via HTTP webhook, return the
   * sub-path (without leading /webhooks/) it wants to receive POSTs on.
   * The full mount path will be `/webhooks/<id>`. Return null for
   * gateway/polling channels that don't need a route.
   */
  webhookPath(): string | null {
    return null;
  }

  /**
   * Handle an incoming webhook request. `rawBody` is the unparsed string
   * body — needed for HMAC signature verification on some platforms.
   * Channels should call `onMessage(msg)` internally when a valid message
   * is extracted and send `res.status(200).end()` (or their own response).
   */
  async handleWebhook(
    _req: WebhookRequest,
    res: WebhookResponse,
    _rawBody: string | null,
  ): Promise<void> {
    res.status(404).end();
  }
}

export interface WebhookRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly method: string;
  readonly query: Record<string, unknown>;
}

export interface WebhookResponse {
  status(code: number): WebhookResponse;
  json(body: unknown): WebhookResponse;
  send(body: string): WebhookResponse;
  end(body?: string): void;
}
