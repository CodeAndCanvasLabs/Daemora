/**
 * Plan → entitlements. The agent-count cap is the primary monetization lever
 * for the multi-agent workforce: free/trial run one agent, paid plans run
 * several, enterprise runs many.
 *
 * Plan names in this codebase: 'trial' | 'lite' | 'pro' (see db/schema.ts).
 * 'free' / 'enterprise' are accepted for forward-compatibility.
 */

const MAX_AGENTS: Readonly<Record<string, number>> = {
  free: 1,
  trial: 1,
  lite: 5,
  pro: 5,
  enterprise: 25,
};

/** How many concurrent agents a plan allows. Unknown / no subscription → 1 (free tier). */
export function maxAgentsForPlan(plan: string | null | undefined): number {
  if (!plan) return MAX_AGENTS.free!;
  return MAX_AGENTS[plan] ?? MAX_AGENTS.free!;
}
