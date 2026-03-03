import { BaseChannel } from "./BaseChannel.js";

/**
 * HTTP Channel - already handled by Express routes in index.js.
 * This class exists for registry consistency but delegates to existing routes.
 */
export class HttpChannel extends BaseChannel {
  constructor(config) {
    super("http", config);
  }

  async start() {
    // HTTP routes are set up in index.js directly
    this.running = true;
    console.log(`[Channel:HTTP] Active (routes handled by Express)`);
  }

  async stop() {
    this.running = false;
  }

  async sendReply(channelMeta, text) {
    // HTTP is sync - response sent directly in the route handler
    // No async reply needed
  }
}
