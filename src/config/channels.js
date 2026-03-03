/**
 * Channel configuration - which input channels are enabled.
 * Actual credentials come from .env via config/default.js.
 */
export const channelDefaults = {
  http: {
    name: "HTTP API",
    enabled: true,
    sync: true, // HTTP waits for task completion before responding
  },
  telegram: {
    name: "Telegram",
    enabled: false, // enabled when TELEGRAM_BOT_TOKEN is set
    sync: false,
  },
  whatsapp: {
    name: "WhatsApp",
    enabled: false, // enabled when TWILIO_ACCOUNT_SID is set
    sync: false,
  },
  email: {
    name: "Email",
    enabled: false, // enabled when EMAIL_USER is set
    sync: false,
    pollIntervalSeconds: 60,
  },
  a2a: {
    name: "Agent-to-Agent (A2A)",
    enabled: false, // enabled in Phase 8
    sync: false,
  },
};
