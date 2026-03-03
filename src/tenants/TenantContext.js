import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-task tenant context using AsyncLocalStorage.
 *
 * This is the correct way to pass per-request state through an async call stack
 * without threading it through every function signature.
 *
 * Usage:
 *   tenantContext.run({ tenant }, async () => { ... });  // in TaskRunner
 *   tenantContext.getStore()?.tenant                     // in any tool/guard
 *
 * Why AsyncLocalStorage and not a global?
 * Multiple tasks run concurrently. A global would have race conditions where
 * tenant A's config bleeds into tenant B's tool calls. AsyncLocalStorage
 * gives each async execution chain its own isolated store.
 */
const tenantContext = new AsyncLocalStorage();
export default tenantContext;
