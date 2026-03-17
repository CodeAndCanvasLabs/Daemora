import { createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Chat } from "./pages/Chat";
import { Logs } from "./pages/Logs";
import { TaskDetail } from "./pages/TaskDetail";
import { Configuration } from "./pages/Configuration";
import { Channels } from "./pages/Channels";
import { MCP } from "./pages/MCP";
import { Skills } from "./pages/Skills";
import { Security } from "./pages/Security";
import { Costs } from "./pages/Costs";
import { Tenants } from "./pages/Tenants";
import { Settings } from "./pages/Settings";
import { Cron } from "./pages/Cron";
import { Plugins } from "./pages/Plugins";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Dashboard },
      { path: "chat", Component: Chat },
      { path: "logs", Component: Logs },
      { path: "logs/:id", Component: TaskDetail },
      // Keep old /tasks routes for backwards compat
      { path: "tasks", Component: Logs },
      { path: "tasks/:id", Component: TaskDetail },
      { path: "config", Component: Configuration },
      { path: "channels", Component: Channels },
      { path: "mcp", Component: MCP },
      { path: "skills", Component: Skills },
      { path: "cron", Component: Cron },
      { path: "security", Component: Security },
      { path: "costs", Component: Costs },
      { path: "tenants", Component: Tenants },
      { path: "plugins", Component: Plugins },
      { path: "settings", Component: Settings },
    ],
  },
]);
