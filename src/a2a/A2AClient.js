/**
 * A2A Client - delegates tasks to external agents via A2A protocol.
 *
 * Flow:
 * 1. Discover agent: fetch /.well-known/agent.json
 * 2. Send task: POST /a2a/tasks
 * 3. Poll for result: GET /a2a/tasks/:id (or stream via SSE)
 */

/**
 * Discover an agent's capabilities.
 * @param {string} agentUrl - Base URL of the agent
 * @returns {object} Agent card
 */
export async function discoverAgent(agentUrl) {
  const url = `${agentUrl.replace(/\/$/, "")}/.well-known/agent.json`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Agent discovery failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Send a task to an external agent.
 * @param {string} agentUrl - Base URL of the agent
 * @param {string} taskInput - The task to send
 * @returns {object} Task response with id and status
 */
export async function sendTaskToAgent(agentUrl, taskInput) {
  const baseUrl = agentUrl.replace(/\/$/, "");

  const response = await fetch(`${baseUrl}/a2a/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: taskInput }],
        },
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`A2A task submission failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Poll for task completion.
 * @param {string} agentUrl - Base URL of the agent
 * @param {string} taskId - Task ID to poll
 * @param {number} maxWaitMs - Maximum wait time in ms (default: 120000)
 * @returns {object} Completed task
 */
export async function pollTaskResult(agentUrl, taskId, maxWaitMs = 120000) {
  const baseUrl = agentUrl.replace(/\/$/, "");
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const response = await fetch(`${baseUrl}/a2a/tasks/${taskId}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`A2A task poll failed: ${response.status}`);
    }

    const data = await response.json();
    const state = data.result?.status?.state;

    if (state === "completed" || state === "failed") {
      const text =
        data.result?.status?.message?.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n") || "";
      return { state, text };
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("A2A task timed out");
}

/**
 * Tool function: delegate a task to an external agent.
 * Used by the agent as a tool call.
 */
export async function delegateToAgent(params) {
  const agentUrl = params?.agentUrl;
  const taskInput = params?.taskInput;
  console.log(`      [A2A] Delegating to ${agentUrl}: "${taskInput.slice(0, 80)}"`);

  try {
    // Discover agent capabilities
    const card = await discoverAgent(agentUrl);
    console.log(
      `      [A2A] Agent: ${card.name} - ${card.skills?.length || 0} skills`
    );

    // Send task
    const submitResult = await sendTaskToAgent(agentUrl, taskInput);
    const taskId = submitResult.result?.id;

    if (!taskId) {
      return `A2A task submission failed: no task ID returned`;
    }

    console.log(`      [A2A] Task submitted: ${taskId}`);

    // Poll for result
    const result = await pollTaskResult(agentUrl, taskId);
    console.log(`      [A2A] Task ${taskId} ${result.state}`);

    return result.text || `Task ${result.state}`;
  } catch (error) {
    console.log(`      [A2A] Error: ${error.message}`);
    return `A2A delegation failed: ${error.message}`;
  }
}

export const delegateToAgentDescription =
  'delegateToAgent(agentUrl: string, taskInput: string) - Delegates a task to another AI agent via A2A protocol. The external agent processes the task and returns the result. agentUrl is the base URL (e.g., "http://localhost:8082").';
