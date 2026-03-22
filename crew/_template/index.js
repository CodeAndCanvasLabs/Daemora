import { myTool } from "./tools/myTool.js";
import { z } from "zod";

export default {
  id: "my-crew-name",     // Must match plugin.json id
  name: "My Crew Member",

  register(api) {
    // Register your tool(s) here
    api.registerTool(
      "myTool",                        // Tool name (unique across all crew)
      myTool,                          // Function from tools/
      z.object({                       // Zod schema for parameter validation
        action: z.enum(["list", "get", "create", "update", "delete"]).describe("Action to perform"),
        id: z.string().optional().describe("Item ID (for get/update/delete)"),
        data: z.string().optional().describe("JSON data (for create/update)"),
      }),
      "myTool(action, id?, data?) — Manage items. action: list | get | create | update | delete"
    );

    // Register more tools if needed:
    // api.registerTool("anotherTool", anotherFn, anotherSchema, "description");

    api.log.info("Registered: myTool");
  },
};
