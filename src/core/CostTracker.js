import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { config } from "../config/default.js";
import { models } from "../config/models.js";
import eventBus from "./EventBus.js";
import tenantContext from "../tenants/TenantContext.js";

const COSTS_DIR = config.costsDir;
mkdirSync(COSTS_DIR, { recursive: true });

/**
 * Get today's cost log file path.
 */
function getTodayLogPath() {
  const today = new Date().toISOString().split("T")[0];
  return `${COSTS_DIR}/${today}.jsonl`;
}

/**
 * Log a cost entry.
 * tenantId is automatically added from TenantContext when available.
 */
export function logCost({ taskId, modelId, inputTokens, outputTokens, estimatedCost, tenantId = null }) {
  const entry = {
    timestamp: new Date().toISOString(),
    taskId,
    modelId,
    inputTokens,
    outputTokens,
    estimatedCost,
    tenantId,
  };
  appendFileSync(getTodayLogPath(), JSON.stringify(entry) + "\n");
}

/**
 * Get total cost spent today (global - all tenants combined).
 */
export function getTodayCost() {
  const logPath = getTodayLogPath();
  if (!existsSync(logPath)) return 0;

  const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  return lines.reduce((sum, line) => {
    try {
      const entry = JSON.parse(line);
      return sum + (entry.estimatedCost || 0);
    } catch {
      return sum;
    }
  }, 0);
}

/**
 * Get total cost spent today for a specific tenant.
 *
 * @param {string} tenantId
 * @returns {number}
 */
export function getTenantTodayCost(tenantId) {
  if (!tenantId) return 0;
  const logPath = getTodayLogPath();
  if (!existsSync(logPath)) return 0;

  const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  return lines.reduce((sum, line) => {
    try {
      const entry = JSON.parse(line);
      if (entry.tenantId !== tenantId) return sum;
      return sum + (entry.estimatedCost || 0);
    } catch {
      return sum;
    }
  }, 0);
}

/**
 * Check if global daily budget is exceeded.
 */
export function isDailyBudgetExceeded() {
  return getTodayCost() >= config.maxDailyCost;
}

/**
 * Check if a specific tenant's daily budget is exceeded.
 *
 * @param {string} tenantId
 * @param {number} maxDailyCost
 * @returns {boolean}
 */
export function isTenantDailyBudgetExceeded(tenantId, maxDailyCost) {
  if (!tenantId || !maxDailyCost) return false;
  return getTenantTodayCost(tenantId) >= maxDailyCost;
}

/**
 * Estimate cost for a model call.
 */
export function estimateCost(modelId, inputTokens, outputTokens) {
  const meta = models[modelId];
  if (!meta) return 0;
  return (inputTokens / 1000) * meta.costPer1kInput + (outputTokens / 1000) * meta.costPer1kOutput;
}

// Auto-log costs from EventBus - includes tenantId from TenantContext
eventBus.on("model:called", (data) => {
  const tenantId = tenantContext.getStore()?.tenant?.id || null;
  const cost = estimateCost(data.modelId, data.inputTokens || 0, data.outputTokens || 0);
  logCost({
    taskId: data.taskId || "unknown",
    modelId: data.modelId,
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    estimatedCost: cost,
    tenantId,
  });
});
