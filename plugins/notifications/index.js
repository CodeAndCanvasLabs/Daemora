import { notification } from "../../src/tools/notification.js";
import toolSchemas from "../../src/tools/schemas.js";

export default {
  id: "notifications",
  name: "Notifications",

  register(api) {
    api.registerTool("notification", notification, toolSchemas.notification?.schema || null,
      "notification(action, ...) — Send push notifications via ntfy or Pushover");

    api.log.info("Registered: notification");
  },
};
