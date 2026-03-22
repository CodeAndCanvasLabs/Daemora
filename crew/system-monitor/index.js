import { systemInfo, systemInfoDescription } from "./tools/systemInfo.js";
import { z } from "zod";

export default {
  id: "system-monitor",
  name: "System Monitor",

  register(api) {
    api.registerTool("systemInfo", systemInfo, z.object({
      action: z.enum(["overview", "disk", "processes", "network", "all"]).describe("What to check"),
      sortBy: z.enum(["cpu", "memory"]).optional().describe("Sort processes by cpu or memory"),
      limit: z.number().optional().describe("Max processes to show (default 10)"),
    }), systemInfoDescription);

    api.log.info("Registered: systemInfo");
  },
};
