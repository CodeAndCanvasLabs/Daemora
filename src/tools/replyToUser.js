/**
 * replyToUser(message) - Send a text message to the current user mid-task.
 *
 * Reads channel + chatId from RequestContext automatically.
 * Use for progress updates, acknowledgments, and intermediate responses
 * while the agent is still working on a task.
 *
 * Does NOT set directReplySent - the final response still goes through
 * the normal channel reply path. This is additive, not a replacement.
 */
import requestContext from "../core/RequestContext.js";
import channelRegistry from "../channels/index.js";

export async function replyToUser(params) {
  const message = params?.message;
  try {
    if (!message) return "Error: message is required.";

    const store = requestContext.getStore();
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
  'replyToUser(message: string) - Send an INTERMEDIATE progress update while still working. ' +
  'ONLY use for: status updates ("Reading the codebase now..."), acknowledgments ("Got it, starting on this..."), or partial findings while work continues. ' +
  'NEVER use for the final answer — put the final response in finalResponse text. ' +
  'NEVER use to deliver completed work or summaries — that goes in finalResponse. ' +
  'Work continues after sending; this does not end the task.';
