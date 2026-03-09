import { createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Chat } from "./pages/Chat";
import { Tasks } from "./pages/Tasks";
import { TaskDetail } from "./pages/TaskDetail";
import { Configuration } from "./pages/Configuration";
import { Channels } from "./pages/Channels";
import { MCP } from "./pages/MCP";
import { Skills } from "./pages/Skills";
import { Security } from "./pages/Security";
import { Costs } from "./pages/Costs";
import { Tenants } from "./pages/Tenants";
import { Settings } from "./pages/Settings";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: Dashboard },
      { path: "chat", Component: Chat },
      { path: "tasks", Component: Tasks },
      { path: "tasks/:id", Component: TaskDetail },
      { path: "config", Component: Configuration },
      { path: "channels", Component: Channels },
      { path: "mcp", Component: MCP },
      { path: "skills", Component: Skills },
      { path: "security", Component: Security },
      { path: "costs", Component: Costs },
      { path: "tenants", Component: Tenants },
      { path: "settings", Component: Settings },
    ],
  },
]);
