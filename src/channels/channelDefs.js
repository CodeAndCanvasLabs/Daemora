/**
 * Shared channel definitions — used by CLI, setup wizard, channels registry, and API.
 *
 * Each definition includes:
 *   name        — internal key (matches channel registry)
 *   label       — display name
 *   desc        — short description
 *   tenantKey   — tenant ID prefix
 *   envRequired — env vars that MUST be set (entries like "KEY=value" mean literal match)
 *   envOptional — [KEY, description] pairs
 *   setup       — setup instruction lines
 *   prompts     — ordered list of env vars to prompt for during interactive setup
 *                 { key, label, type: "password"|"text", initialValue?, placeholder? }
 *   subFlows    — optional follow-up prompts triggered by confirm()
 */

export const CHANNEL_DEFS = [
  {
    name: "telegram", label: "Telegram", desc: "Bot via @BotFather",
    tenantKey: "telegram",
    envRequired: ["TELEGRAM_BOT_TOKEN"],
    envOptional: [
      ["TELEGRAM_ALLOWLIST",  "Comma-separated chat IDs allowed to message the bot. Empty = open."],
      ["TELEGRAM_MODEL",      "Model override for this channel (e.g. anthropic:claude-sonnet-4-6)"],
    ],
    setup: [
      "1. Open Telegram → search @BotFather",
      "2. Send /newbot and follow the prompts",
      "3. Copy the token (format: 123456789:ABCdef...)",
    ],
    prompts: [
      { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", type: "password" },
    ],
  },
  {
    name: "whatsapp", label: "WhatsApp", desc: "Via Twilio (sandbox or dedicated number)",
    tenantKey: "whatsapp",
    envRequired: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    envOptional: [
      ["TWILIO_WHATSAPP_FROM",  "Sending number (default: whatsapp:+14155238886 sandbox)"],
      ["WHATSAPP_ALLOWLIST",    "Comma-separated phone numbers allowed (+1234567890)"],
      ["WHATSAPP_MODEL",        "Model override for this channel"],
    ],
    setup: [
      "1. Sign up at https://console.twilio.com",
      "2. Copy Account SID + Auth Token from the dashboard",
      "3. Messaging › Try it out › WhatsApp → join sandbox",
    ],
    prompts: [
      { key: "TWILIO_ACCOUNT_SID",   label: "Twilio Account SID",  type: "password" },
      { key: "TWILIO_AUTH_TOKEN",     label: "Twilio Auth Token",   type: "password" },
      { key: "TWILIO_WHATSAPP_FROM",  label: "WhatsApp From number", type: "text", initialValue: "whatsapp:+14155238886" },
    ],
    subFlows: [
      {
        confirm: "Enable voice calls? (needs a voice-capable Twilio number + public URL)",
        prompts: [
          { key: "TWILIO_PHONE_FROM",      label: "Twilio voice-capable phone number (e.g. +1234567890)", type: "text" },
          { key: "VOICE_WEBHOOK_BASE_URL", label: "Public URL for voice webhooks (e.g. https://abc123.ngrok.io)", type: "text" },
        ],
      },
    ],
  },
  {
    name: "discord", label: "Discord", desc: "Bot via Discord Developer Portal",
    tenantKey: "discord",
    envRequired: ["DISCORD_BOT_TOKEN"],
    envOptional: [
      ["DISCORD_ALLOWLIST", "Comma-separated Discord user snowflake IDs"],
      ["DISCORD_MODEL",     "Model override for this channel"],
    ],
    setup: [
      "1. https://discord.com/developers/applications → New Application → Bot",
      "2. Reset Token → copy it",
      "3. Enable 'Message Content Intent' under Privileged Intents",
      "4. OAuth2 URL Generator → bot scope → Send Messages, Read Message History",
      "5. Invite bot to your server with the generated URL",
    ],
    prompts: [
      { key: "DISCORD_BOT_TOKEN", label: "Discord bot token", type: "password" },
    ],
  },
  {
    name: "slack", label: "Slack", desc: "Socket Mode bot",
    tenantKey: "slack",
    envRequired: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    envOptional: [
      ["SLACK_ALLOWLIST", "Comma-separated Slack user IDs (Uxxxxxxxxx)"],
      ["SLACK_MODEL",     "Model override for this channel"],
    ],
    setup: [
      "1. https://api.slack.com/apps → Create New App → From scratch",
      "2. Socket Mode → Enable → App-Level Token (xapp-...) → copy as SLACK_APP_TOKEN",
      "3. OAuth & Permissions → Bot Scopes: chat:write, im:history, app_mentions:read",
      "4. Install to workspace → Bot Token (xoxb-...) → copy as SLACK_BOT_TOKEN",
    ],
    prompts: [
      { key: "SLACK_BOT_TOKEN", label: "Slack Bot Token (xoxb-...)", type: "password" },
      { key: "SLACK_APP_TOKEN", label: "Slack App Token (xapp-...)", type: "password" },
    ],
  },
  {
    name: "email", label: "Email", desc: "Gmail IMAP/SMTP (reads + sends)",
    tenantKey: "email",
    envRequired: ["EMAIL_USER", "EMAIL_PASSWORD"],
    envOptional: [
      ["EMAIL_IMAP_HOST",  "IMAP host (default: imap.gmail.com)"],
      ["EMAIL_SMTP_HOST",  "SMTP host (default: smtp.gmail.com)"],
      ["EMAIL_ALLOWLIST",  "Comma-separated allowed sender emails"],
      ["EMAIL_MODEL",      "Model override for this channel"],
      ["RESEND_API_KEY",   "Alternative: Resend.com API key for sending only"],
      ["RESEND_FROM",      "Resend from address (e.g. you@yourdomain.com)"],
    ],
    setup: [
      "Gmail: Google Account › Security › 2-Step Verification → enable",
      "Then: Security › App Passwords → Mail → create 16-char password",
      "Use that app password as EMAIL_PASSWORD (NOT your Gmail password)",
    ],
    prompts: [
      { key: "EMAIL_USER",     label: "Email address",     type: "text" },
      { key: "EMAIL_PASSWORD", label: "App password",      type: "password" },
      { key: "EMAIL_IMAP_HOST", label: "IMAP host",        type: "text", initialValue: "imap.gmail.com" },
      { key: "EMAIL_SMTP_HOST", label: "SMTP host",        type: "text", initialValue: "smtp.gmail.com" },
    ],
    subFlows: [
      {
        confirm: "Also configure Resend for sending? (alternative to SMTP)",
        prompts: [
          { key: "RESEND_API_KEY", label: "Resend API key (re_...)", type: "password" },
          { key: "RESEND_FROM",    label: "Resend from address",     type: "text", placeholder: "you@yourdomain.com" },
        ],
      },
    ],
  },
  {
    name: "line", label: "LINE", desc: "LINE Messaging API",
    tenantKey: "line",
    envRequired: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
    envOptional: [
      ["LINE_ALLOWLIST", "Comma-separated LINE user IDs (Uxxxxxxxxxx)"],
      ["LINE_MODEL",     "Model override for this channel"],
    ],
    setup: [
      "1. https://developers.line.biz → Create Provider → Messaging API channel",
      "2. Basic settings → Channel Secret",
      "3. Messaging API → Channel Access Token (long-lived) → Issue",
      "4. Webhook URL: https://your-server/webhooks/line",
    ],
    prompts: [
      { key: "LINE_CHANNEL_ACCESS_TOKEN", label: "LINE Channel Access Token", type: "password" },
      { key: "LINE_CHANNEL_SECRET",       label: "LINE Channel Secret",       type: "password" },
    ],
  },
  {
    name: "signal", label: "Signal", desc: "signal-cli REST daemon",
    tenantKey: "signal",
    envRequired: ["SIGNAL_CLI_URL", "SIGNAL_PHONE_NUMBER"],
    envOptional: [
      ["SIGNAL_ALLOWLIST", "Comma-separated phone numbers (+1234567890)"],
      ["SIGNAL_MODEL",     "Model override for this channel"],
    ],
    setup: [
      "Install signal-cli: https://github.com/AsamK/signal-cli",
      "Register: signal-cli -u +1234567890 register",
      "Verify:   signal-cli -u +1234567890 verify <code>",
      "Daemon:   signal-cli -u +1234567890 daemon --http 127.0.0.1:8080",
    ],
    prompts: [
      { key: "SIGNAL_CLI_URL",      label: "signal-cli REST URL",              type: "text", initialValue: "http://127.0.0.1:8080" },
      { key: "SIGNAL_PHONE_NUMBER", label: "Your Signal phone number (+1234567890)", type: "text" },
    ],
  },
  {
    name: "teams", label: "Microsoft Teams", desc: "Azure Bot Framework",
    tenantKey: "teams",
    envRequired: ["TEAMS_APP_ID", "TEAMS_APP_PASSWORD"],
    envOptional: [
      ["TEAMS_ALLOWLIST", "Comma-separated Teams user IDs or AAD object IDs"],
      ["TEAMS_MODEL",     "Model override for this channel"],
    ],
    setup: [
      "1. https://portal.azure.com → Create an Azure Bot",
      "2. Configuration → Messaging endpoint: https://your-server/webhooks/teams",
      "3. Copy App ID  +  Manage Password → New client secret",
      "4. Channels → Add Microsoft Teams",
    ],
    prompts: [
      { key: "TEAMS_APP_ID",       label: "Teams App ID (UUID)",                type: "text" },
      { key: "TEAMS_APP_PASSWORD", label: "Teams App Password (client secret)", type: "password" },
    ],
  },
  {
    name: "googlechat", label: "Google Chat", desc: "Google Cloud service account",
    tenantKey: "googlechat",
    envRequired: ["GOOGLE_CHAT_SERVICE_ACCOUNT"],
    envOptional: [
      ["GOOGLE_CHAT_PROJECT_NUMBER", "GCP project number"],
      ["GOOGLE_CHAT_ALLOWLIST",      "Comma-separated Google user IDs or emails"],
      ["GOOGLE_CHAT_MODEL",          "Model override for this channel"],
    ],
    setup: [
      "1. GCP Console → Enable 'Google Chat API'",
      "2. IAM → Service Accounts → Create → download JSON key",
      "3. Chat API → Configuration → Bot URL: https://your-server/webhooks/googlechat",
      "4. Paste entire JSON key as one line into GOOGLE_CHAT_SERVICE_ACCOUNT",
    ],
    prompts: [
      { key: "GOOGLE_CHAT_SERVICE_ACCOUNT", label: "Service account JSON (one line)", type: "text" },
      { key: "GOOGLE_CHAT_PROJECT_NUMBER",  label: "Google Cloud project number",     type: "text" },
    ],
  },
  {
    name: "matrix", label: "Matrix", desc: "Element / matrix.org protocol",
    tenantKey: "matrix",
    envRequired: ["MATRIX_HOMESERVER_URL", "MATRIX_ACCESS_TOKEN"],
    envOptional: [
      ["MATRIX_BOT_USER_ID", "Bot user ID (e.g. @daemora:matrix.org)"],
    ],
    setup: [
      "1. Create bot account on matrix.org or your homeserver",
      "2. Get access token:",
      "   POST /_matrix/client/v3/login",
      '   {"type":"m.login.password","user":"@bot:matrix.org","password":"..."}',
      "3. Copy 'access_token' from response",
    ],
    prompts: [
      { key: "MATRIX_HOMESERVER_URL", label: "Homeserver URL",                       type: "text", initialValue: "https://matrix.org" },
      { key: "MATRIX_ACCESS_TOKEN",   label: "Bot access token",                     type: "password" },
      { key: "MATRIX_BOT_USER_ID",    label: "Bot user ID (e.g. @daemora:matrix.org)", type: "text" },
    ],
  },
  {
    name: "mattermost", label: "Mattermost", desc: "WebSocket bot",
    tenantKey: "mattermost",
    envRequired: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
    envOptional: [
      ["MATTERMOST_BOT_USER_ID",  "Bot user ID"],
      ["MATTERMOST_BOT_USERNAME", "Bot username (default: daemora-bot)"],
    ],
    setup: [
      "1. System Console → Integrations → Bot Accounts → Enable",
      "2. Integrations → Bot Accounts → Add Bot Account",
      "3. Copy the bot token shown after creation",
      "4. Find bot user ID: GET /api/v4/users/me  (Authorization: Bearer <token>)",
    ],
    prompts: [
      { key: "MATTERMOST_URL",         label: "Mattermost URL",                type: "text", placeholder: "https://your-mattermost.example.com" },
      { key: "MATTERMOST_TOKEN",       label: "Bot token",                     type: "password" },
      { key: "MATTERMOST_BOT_USER_ID", label: "Bot user ID (optional)",        type: "text" },
    ],
  },
  {
    name: "twitch", label: "Twitch", desc: "Chat commands (!ask prefix)",
    tenantKey: "twitch",
    envRequired: ["TWITCH_BOT_USERNAME", "TWITCH_OAUTH_TOKEN", "TWITCH_CHANNEL"],
    envOptional: [
      ["TWITCH_COMMAND_PREFIX", "Command prefix (default: !ask)"],
    ],
    setup: [
      "1. Create a Twitch account for your bot",
      "2. Get OAuth token at https://twitchapps.com/tmi/ (authorize as bot account)",
      "3. Copy the oauth:... token",
    ],
    prompts: [
      { key: "TWITCH_BOT_USERNAME", label: "Bot Twitch username",       type: "text" },
      { key: "TWITCH_OAUTH_TOKEN",  label: "OAuth token (oauth:...)",   type: "password" },
      { key: "TWITCH_CHANNEL",      label: "Channel to join (without #)", type: "text" },
    ],
  },
  {
    name: "irc", label: "IRC", desc: "Any IRC network — no external packages",
    tenantKey: "irc",
    envRequired: ["IRC_SERVER", "IRC_NICK"],
    envOptional: [
      ["IRC_PORT",     "Port (default: 6667)"],
      ["IRC_CHANNEL",  "Channel to join (e.g. #mychannel)"],
      ["IRC_PASSWORD", "NickServ password"],
    ],
    setup: [
      "Popular networks: irc.libera.chat  irc.freenode.net  irc.oftc.net",
      "Uses raw TCP — no npm packages needed.",
    ],
    prompts: [
      { key: "IRC_SERVER",  label: "IRC server",              type: "text", initialValue: "irc.libera.chat" },
      { key: "IRC_PORT",    label: "IRC port",                type: "text", initialValue: "6667" },
      { key: "IRC_NICK",    label: "Bot nick",                type: "text", initialValue: "daemora-bot" },
      { key: "IRC_CHANNEL", label: "Channel to join (e.g. #mychannel)", type: "text" },
      { key: "IRC_PASSWORD", label: "NickServ password (optional)", type: "password" },
    ],
  },
  {
    name: "imessage", label: "iMessage", desc: "macOS only — AppleScript polling",
    tenantKey: "imessage",
    envRequired: ["IMESSAGE_ENABLED=true"],
    envOptional: [
      ["IMESSAGE_POLL_INTERVAL_MS", "Poll interval in ms (default: 5000)"],
      ["IMESSAGE_ALLOWLIST",        "Comma-separated phone numbers or iCloud emails"],
    ],
    setup: [
      "macOS only. Messages app must be open and signed in.",
      "System Preferences › Privacy & Security › Accessibility → allow Terminal",
      "Set IMESSAGE_ENABLED=true in your .env",
    ],
    prompts: [
      { key: "IMESSAGE_ENABLED", label: "Enable iMessage", type: "text", initialValue: "true" },
      { key: "IMESSAGE_POLL_INTERVAL_MS", label: "Poll interval (ms)", type: "text", initialValue: "5000" },
    ],
    platformCheck: "darwin",
  },
  {
    name: "feishu", label: "Feishu / Lark", desc: "Bytedance enterprise messaging",
    tenantKey: "feishu",
    envRequired: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
    envOptional: [
      ["FEISHU_VERIFICATION_TOKEN", "Webhook verification token"],
      ["FEISHU_PORT",               "Webhook port (default: 3004)"],
    ],
    setup: [
      "1. https://open.feishu.cn/app → Create App",
      "2. Credentials & Basic Info → App ID + App Secret",
      "3. Add capability: Bot",
      "4. Event Subscriptions → webhook: https://your-server/channels/feishu",
      "5. Subscribe to: im.message.receive_v1",
    ],
    prompts: [
      { key: "FEISHU_APP_ID",            label: "Feishu App ID",                    type: "text" },
      { key: "FEISHU_APP_SECRET",        label: "Feishu App Secret",                type: "password" },
      { key: "FEISHU_VERIFICATION_TOKEN", label: "Verification token (optional)",   type: "password" },
    ],
  },
  {
    name: "zalo", label: "Zalo", desc: "Vietnam — 75M+ users",
    tenantKey: "zalo",
    envRequired: ["ZALO_APP_ID", "ZALO_ACCESS_TOKEN"],
    envOptional: [
      ["ZALO_APP_SECRET", "Zalo App Secret"],
      ["ZALO_PORT",       "Webhook port (default: 3005)"],
    ],
    setup: [
      "1. Register Official Account at https://oa.zalo.me",
      "2. Create app at https://developers.zalo.me → API Tools",
      "3. Get access token via OAuth",
      "4. Webhook: https://your-server/channels/zalo",
    ],
    prompts: [
      { key: "ZALO_APP_ID",      label: "Zalo App ID",      type: "text" },
      { key: "ZALO_APP_SECRET",  label: "Zalo App Secret",  type: "password" },
      { key: "ZALO_ACCESS_TOKEN", label: "Zalo Access Token", type: "password" },
    ],
  },
  {
    name: "nextcloud", label: "Nextcloud Talk", desc: "Self-hosted collaboration",
    tenantKey: "nextcloud",
    envRequired: ["NEXTCLOUD_URL", "NEXTCLOUD_USER", "NEXTCLOUD_PASSWORD"],
    envOptional: [
      ["NEXTCLOUD_ROOM_TOKEN", "Talk room token (from /call/<token> in URL)"],
    ],
    setup: [
      "1. Nextcloud → Profile → Settings → Security",
      "2. Devices & Sessions → create App Password for the bot account",
      "3. Find room token in Talk URL: /call/<room-token>",
    ],
    prompts: [
      { key: "NEXTCLOUD_URL",        label: "Nextcloud URL",         type: "text", placeholder: "https://cloud.example.com" },
      { key: "NEXTCLOUD_USER",       label: "Bot username",          type: "text", initialValue: "daemora-bot" },
      { key: "NEXTCLOUD_PASSWORD",   label: "App password",          type: "password" },
      { key: "NEXTCLOUD_ROOM_TOKEN", label: "Room token (from Talk URL)", type: "text" },
    ],
  },
  {
    name: "bluebubbles", label: "BlueBubbles", desc: "iMessage relay server (Mac required)",
    tenantKey: "bluebubbles",
    envRequired: ["BLUEBUBBLES_URL", "BLUEBUBBLES_PASSWORD"],
    envOptional: [],
    setup: [
      "1. Install BlueBubbles on a Mac signed into iMessage",
      "   https://bluebubbles.app",
      "2. Settings → Server → copy Server URL + Password",
    ],
    prompts: [
      { key: "BLUEBUBBLES_URL",      label: "BlueBubbles server URL",      type: "text", placeholder: "http://192.168.1.100:1234" },
      { key: "BLUEBUBBLES_PASSWORD", label: "BlueBubbles server password", type: "password" },
    ],
  },
  {
    name: "nostr", label: "Nostr", desc: "Decentralized protocol — NIP-04 encrypted DMs",
    tenantKey: "nostr",
    envRequired: ["NOSTR_PRIVATE_KEY"],
    envOptional: [
      ["NOSTR_RELAYS", "Comma-separated relay WSS URLs"],
    ],
    setup: [
      "Generate private key:  openssl rand -hex 32",
      "Share the bot's npub (public key) so users can DM it.",
      "Default relays: relay.damus.io, nos.lol, relay.nostr.band",
    ],
    prompts: [
      { key: "NOSTR_PRIVATE_KEY", label: "Nostr private key (hex, 64 chars)", type: "password" },
      { key: "NOSTR_RELAYS",      label: "Relay URLs (comma-separated)",      type: "text", initialValue: "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band" },
    ],
  },
];

/**
 * Check if a channel is configured based on its envRequired.
 */
export function isChannelConfigured(ch) {
  return ch.envRequired.every(e => {
    const [k, v] = e.split("=");
    return v ? process.env[k] === v : !!process.env[k];
  });
}
