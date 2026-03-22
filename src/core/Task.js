import { v4 as uuidv4 } from "uuid";

/**
 * Task data model.
 *
 * States: pending → running → completed | failed
 *
 * Every incoming request (from any channel) becomes a Task.
 */
export function createTask({
  input,
  channel = "http",
  channelMeta = {},
  sessionId = null,
  priority = 5,
  model = null,
  maxCost = null,
  approvalMode = "auto",
  // ── Task system fields ──────────────────────────────────────────────────
  type = "chat",            // "chat" (from user message) | "task" (agent-created)
  title = null,             // short descriptive title (agent-created tasks)
  description = null,       // detailed task description
  parentTaskId = null,      // ID of parent task (for hierarchy)
  agentId = null,           // which agent/sub-agent is executing
  agentCreated = false,     // whether the agent created this task vs system
  extraDestinations = null, // additional channel destinations for watcher multi-delivery
}) {
  return {
    id: uuidv4(),
    status: "pending",
    type,                 // chat | task
    title,                // short title for agent-created tasks
    description,          // detailed description
    input,                // user's message text
    channel,              // http | telegram | whatsapp | email | a2a
    channelMeta,          // channel-specific metadata (chat_id, phone, email, etc.)
    sessionId,            // link to conversation session
    priority,             // 1 (highest) - 10 (lowest)
    model,                // explicit model override or null (use default)
    maxCost,              // per-task cost budget or null (use global)
    approvalMode,         // auto | dangerous-only | every-tool | milestones
    parentTaskId,         // parent task ID (for hierarchy)
    agentId,              // executing agent/sub-agent ID
    agentCreated,         // true if created by agent via taskManager tool
    extraDestinations,    // watcher multi-delivery: [{channel, channelMeta}]
    result: null,         // final response text
    error: null,          // error message if failed
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      modelCalls: 0,
    },
    toolCalls: [],        // log of tool calls: { tool, params, duration, output_preview }
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

/**
 * Task state transitions.
 */
export function startTask(task) {
  task.status = "running";
  task.startedAt = new Date().toISOString();
  return task;
}

export function completeTask(task, result) {
  task.status = "completed";
  task.result = result;
  task.completedAt = new Date().toISOString();
  return task;
}

export function failTask(task, error) {
  task.status = "failed";
  task.error = error;
  task.completedAt = new Date().toISOString();
  return task;
}
