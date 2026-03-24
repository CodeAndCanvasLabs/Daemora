import { sshTool } from "./tools/sshTool.js";

export default {
  id: "ssh-remote",
  name: "SSH Remote",

  register(api) {
    api.registerTool("sshTool", sshTool, null,
      "sshTool(action, ...) - SSH remote exec, SCP file transfer, tunnel management");

    api.log.info("Registered: sshTool");
  },
};
