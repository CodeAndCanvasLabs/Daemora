import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-task request context using AsyncLocalStorage.
 *
 * Passes per-request state through async call stack without threading
 * through every function signature. Each concurrent task gets isolated store.
 *
 * Store shape:
 *   { resolvedModel, apiKeys, sessionId, channelMeta, directReplySent, currentTaskId, agentId }
 *
 * Usage:
 *   requestContext.run({ ... }, async () => { ... });  // in TaskRunner
 *   requestContext.getStore()?.channelMeta              // in any tool/guard
 */
const requestContext = new AsyncLocalStorage();
export default requestContext;
