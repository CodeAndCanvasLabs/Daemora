import { createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Chat } from "./pages/Chat";
import { Logs } from "./pages/Logs";
import { TaskDetail } from "./pages/TaskDetail";
import { Channels } from "./pages/Channels";
import { MCP } from "./pages/MCP";
import { Skills } from "./pages/Skills";
import { Security } from "./pages/Security";
import { Costs } from "./pages/Costs";
import { Tenants } from "./pages/Tenants";
import { Settings } from "./pages/Settings";
import { Cron } from "./pages/Cron";
import { Goals } from "./pages/Goals";
import { Watchers } from "./pages/Watchers";
import { Crew } from "./pages/Crew";
import { Teams } from "./pages/Teams";

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
      { path: "config", Component: Settings },
      { path: "channels", Component: Channels },
      { path: "mcp", Component: MCP },
      { path: "skills", Component: Skills },
      { path: "cron", Component: Cron },
      { path: "goals", Component: Goals },
      { path: "watchers", Component: Watchers },
      { path: "security", Component: Security },
      { path: "costs", Component: Costs },
      { path: "tenants", Component: Tenants },
      { path: "crew", Component: Crew },
      { path: "teams", Component: Teams },
      { path: "settings", Component: Settings },
    ],
  },
]);
