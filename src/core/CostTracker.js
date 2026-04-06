import { config } from "../config/default.js";
import { models } from "../config/models.js";
import eventBus from "./EventBus.js";
import { queryOne, run } from "../storage/Database.js";

/**
 * Log a cost entry.
 */
export function logCost({ taskId, modelId, inputTokens, outputTokens, estimatedCost }) {
  run(
    `INSERT INTO cost_entries (task_id, model_id, input_tokens, output_tokens, estimated_cost, created_at)
     VALUES ($task_id, $model_id, $input, $output, $cost, $created_at)`,
    {
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
 * Get total cost spent today.
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
 * Check if daily budget is exceeded.
 */
export function isDailyBudgetExceeded() {
  return getTodayCost() >= config.maxDailyCost;
}

/**
 * Estimate cost for a model call.
 */
export function estimateCost(modelId, inputTokens, outputTokens) {
  const meta = models[modelId];
  if (!meta) return 0;
  return (inputTokens / 1000) * meta.costPer1kInput + (outputTokens / 1000) * meta.costPer1kOutput;
}

// Auto-log costs from EventBus
eventBus.on("model:called", (data) => {
  const cost = estimateCost(data.modelId, data.inputTokens || 0, data.outputTokens || 0);
  logCost({
    taskId: data.taskId || "unknown",
    modelId: data.modelId,
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    estimatedCost: cost,
  });
});
