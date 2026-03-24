/**
 * replyToUser(message) - Send a text message to the current user mid-task.
 *
 * Reads channel + chatId from TenantContext automatically.
 * Use for progress updates, acknowledgments, and intermediate responses
 * while the agent is still working on a task.
 *
 * Does NOT set directReplySent - the final response still goes through
 * the normal channel reply path. This is additive, not a replacement.
 */
import tenantContext from "../tenants/TenantContext.js";
import channelRegistry from "../channels/index.js";

export async function replyToUser(params) {
  const message = params?.message;
  try {
    if (!message) return "Error: message is required.";

    const store = tenantContext.getStore();
    const channelMeta = store?.channelMeta;

    if (!channelMeta?.channel || (!channelMeta?.chatId && !channelMeta?.channelId)) {
      return "No active channel context - user is on HTTP/API. Progress noted internally.";
    }

    const ch = channelRegistry.get(channelMeta.channel, channelMeta.instanceKey);
    if (!ch || !ch.running) {
      return "Channel not available. Progress noted internally.";
    }

    await ch.sendReply(channelMeta, message);
    return `Progress update sent to user.`;
  } catch (error) {
    return `Could not send progress update: ${error.message}`;
  }
}

export const replyToUserDescription =
  'replyToUser(message: string) - Send a text message to the current user mid-task. ' +
  'Use for progress updates ("Working on the API routes now..."), acknowledgments when the user sends a follow-up, ' +
  'or intermediate results while still working. Does not end the task - work continues after sending.';
