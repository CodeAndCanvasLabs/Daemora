/**
 * createPoll - Create a poll in the user's active channel.
 * Routes to the channel's sendPoll() method.
 */
import channelRegistry from "../channels/index.js";
import requestContext from "../core/RequestContext.js";

export async function createPoll(params) {
  const { question, options } = params;
  if (!question) return "Error: question is required.";
  if (!options || !Array.isArray(options) || options.length < 2) {
    return "Error: options must be an array with at least 2 choices.";
  }
  if (options.length > 10) return "Error: maximum 10 options allowed.";

  const duration = params.duration || 24;
  const store = requestContext.getStore();
  const channelMeta = store?.channelMeta;
  const channelName = channelMeta?.channel;

  if (!channelName || !channelMeta) {
    return "Error: No active channel context. Poll can only be created in a channel conversation.";
  }

  const channel = channelRegistry.get(channelName);
  if (!channel) return `Error: Channel "${channelName}" not found.`;

  try {
    await channel.sendPoll(channelMeta, question, options, duration);
    return `Poll created: "${question}" with ${options.length} options.`;
  } catch (err) {
    return `Error creating poll: ${err.message}`;
  }
}
