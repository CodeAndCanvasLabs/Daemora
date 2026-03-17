import { sshTool } from "../../src/tools/sshTool.js";
import toolSchemas from "../../src/tools/schemas.js";

export default {
  id: "ssh-remote",
  name: "SSH Remote",

  register(api) {
    api.registerTool("sshTool", sshTool, toolSchemas.sshTool?.schema || null,
      "sshTool(action, ...) — SSH remote exec, SCP file transfer, tunnel management");

    api.log.info("Registered: sshTool");
  },
};
