import { config } from "../config/default.js";
import { models } from "../config/models.js";
import eventBus from "./EventBus.js";
import tenantContext from "../tenants/TenantContext.js";
import { queryOne, run } from "../storage/Database.js";

/**
 * Log a cost entry.
 * tenantId is automatically added from TenantContext when available.
 */
export function logCost({ taskId, modelId, inputTokens, outputTokens, estimatedCost, tenantId = null }) {
  run(
    `INSERT INTO cost_entries (tenant_id, task_id, model_id, input_tokens, output_tokens, estimated_cost, created_at)
     VALUES ($tenant_id, $task_id, $model_id, $input, $output, $cost, $created_at)`,
    {
      $tenant_id: tenantId,
      $task_id: taskId || "unknown",
      $model_id: modelId || null,
      $input: inputTokens || 0,
      $output: outputTokens || 0,
      $cost: estimatedCost || 0,
      $created_at: new Date().toISOString(),
    }
  );
}

/**
 * Get total cost spent today (global - all tenants combined).
 */
export function getTodayCost() {
  const today = new Date().toISOString().split("T")[0];
  const row = queryOne(
    "SELECT COALESCE(SUM(estimated_cost), 0) as total FROM cost_entries WHERE created_at >= $start",
    { $start: today }
  );
  return row.total;
}

/**
 * Get total cost spent today for a specific tenant.
 */
export function getTenantTodayCost(tenantId) {
  if (!tenantId) return 0;
  const today = new Date().toISOString().split("T")[0];
  const row = queryOne(
    "SELECT COALESCE(SUM(estimated_cost), 0) as total FROM cost_entries WHERE tenant_id = $tid AND created_at >= $start",
    { $tid: tenantId, $start: today }
  );
  return row.total;
}

/**
 * Check if global daily budget is exceeded.
 */
export function isDailyBudgetExceeded() {
  return getTodayCost() >= config.maxDailyCost;
}

/**
 * Check if a specific tenant's daily budget is exceeded.
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
