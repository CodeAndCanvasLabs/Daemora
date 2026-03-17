import { iMessageTool } from "../../src/tools/iMessageTool.js";
import toolSchemas from "../../src/tools/schemas.js";

export default {
  id: "imessage",
  name: "iMessage",

  register(api) {
    api.registerTool("iMessageTool", iMessageTool, toolSchemas.iMessageTool?.schema || null,
      "iMessageTool(action, ...) — Send/read iMessages via AppleScript (macOS only)");

    api.log.info("Registered: iMessageTool");
  },
};
