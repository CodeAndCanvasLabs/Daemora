import { iMessageTool } from "./tools/iMessageTool.js";

export default {
  id: "imessage",
  name: "iMessage",

  register(api) {
    api.registerTool("iMessageTool", iMessageTool, null,
      "iMessageTool(action, ...) — Send/read iMessages via AppleScript (macOS only)");

    api.log.info("Registered: iMessageTool");
  },
};
