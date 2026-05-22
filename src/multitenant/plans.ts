/**
 * Plan presets — what each tier gets. Single source of truth for:
 *   - cost caps
 *   - default profile
 *   - Machine sizing (informational in local dev; meaningful when
 *     control plane talks to the Fly Machines API)
 *   - feature flags (voice / playwright / video)
 *
 * Applying a plan writes the preset into `tenant_config` rows so the
 * spawned daemora subprocess picks them up via env. Operator can
 * override per-tenant after the plan is applied (`tenant set …`).
 */

import type { Plan } from "./types.js";

export interface PlanPreset {
  readonly permissionTier: "minimal" | "standard" | "full";
  readonly profileId: string | null;       // null = user picks at first run
  readonly defaultModel: string;
  readonly maxDailyCost: number;           // USD
  readonly maxCostPerTask: number;         // USD
  readonly machine: {
    readonly cpus: number;
    readonly memoryMb: number;
  };
  readonly volumeGb: number;
  readonly features: {
    readonly voice: boolean;
    readonly playwright: boolean;
    readonly video: boolean;
  };
  /** If non-null, this list overrides the tier's default — narrows callable tools further. */
  readonly allowedTools: readonly string[] | null;
}

export const PLANS: Readonly<Record<Plan, PlanPreset>> = Object.freeze({
  trial: {
    permissionTier: "standard",
    profileId: null,
    defaultModel: "anthropic:claude-haiku-4-5",
    maxDailyCost: 1.0,
    maxCostPerTask: 0.20,
    machine: { cpus: 2, memoryMb: 2048 },
    volumeGb: 5,
    features: { voice: true, playwright: true, video: false },
    allowedTools: null,
  },
  lite: {
    permissionTier: "minimal",
    profileId: "daemora",
    defaultModel: "openai:gpt-4o-mini",
    maxDailyCost: 0.50,
    maxCostPerTask: 0.10,
    machine: { cpus: 1, memoryMb: 1024 },
    volumeGb: 5,
    features: { voice: false, playwright: false, video: false },
    allowedTools: null,
  },
  pro: {
    permissionTier: "standard",
    profileId: null,
    defaultModel: "anthropic:claude-sonnet-4-6",
    maxDailyCost: 5.0,
    maxCostPerTask: 1.0,
    machine: { cpus: 2, memoryMb: 4096 },
    volumeGb: 20,
    features: { voice: true, playwright: true, video: true },
    allowedTools: null,
  },
});

/** All config-key/value pairs a plan preset writes into `tenant_config`. */
export function planConfigEntries(plan: Plan): Array<{ key: string; value: unknown }> {
  const p = PLANS[plan];
  const out: Array<{ key: string; value: unknown }> = [
    { key: "permissionTier", value: p.permissionTier },
    { key: "defaultModel", value: p.defaultModel },
    { key: "maxDailyCost", value: p.maxDailyCost },
    { key: "maxCostPerTask", value: p.maxCostPerTask },
    { key: "machineCpus", value: p.machine.cpus },
    { key: "machineMemoryMb", value: p.machine.memoryMb },
    { key: "volumeGb", value: p.volumeGb },
    { key: "featureVoice", value: p.features.voice },
    { key: "featurePlaywright", value: p.features.playwright },
    { key: "featureVideo", value: p.features.video },
  ];
  if (p.profileId !== null) out.push({ key: "profileId", value: p.profileId });
  if (p.allowedTools !== null) out.push({ key: "allowedTools", value: p.allowedTools });
  return out;
}
