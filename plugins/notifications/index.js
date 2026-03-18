import { notification } from "./tools/notification.js";

export default {
  id: "notifications",
  name: "Notifications",

  register(api) {
    api.registerTool("notification", notification, null,
      "notification(action, ...) — Send push notifications via ntfy or Pushover");

    api.log.info("Registered: notification");
  },
};
