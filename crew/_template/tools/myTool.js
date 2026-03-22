/**
 * myTool — replace this with your tool implementation.
 *
 * Rules:
 * - Always return a string (the agent reads this as the tool result)
 * - Handle errors gracefully — return error messages, don't throw
 * - Use params?.field (defensive access)
 * - For API calls, read credentials from env or tenantContext
 *
 * @param {object} params - Validated by Zod schema in index.js
 * @returns {string} Result text
 */
export async function myTool(params) {
  const action = params?.action || "list";

  switch (action) {
    case "list":
      // TODO: Replace with your actual list logic
      return JSON.stringify([
        { id: "1", name: "Example Item 1" },
        { id: "2", name: "Example Item 2" },
      ], null, 2);

    case "get": {
      if (!params.id) return "Error: id is required for get";
      // TODO: Replace with your actual get logic
      return JSON.stringify({ id: params.id, name: "Example Item", status: "active" }, null, 2);
    }

    case "create": {
      if (!params.data) return "Error: data is required for create";
      // TODO: Replace with your actual create logic
      return `Created successfully. Data: ${params.data}`;
    }

    case "update": {
      if (!params.id) return "Error: id is required for update";
      if (!params.data) return "Error: data is required for update";
      // TODO: Replace with your actual update logic
      return `Updated item ${params.id}. Data: ${params.data}`;
    }

    case "delete": {
      if (!params.id) return "Error: id is required for delete";
      // TODO: Replace with your actual delete logic
      return `Deleted item ${params.id}`;
    }

    default:
      return `Unknown action "${action}". Use: list, get, create, update, delete`;
  }
}
