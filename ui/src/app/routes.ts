import { createElement } from "react";
import { createBrowserRouter } from "react-router";
import { AuthGate } from "./components/AuthGate";
import { AppShell } from "./components/AppShell";
import { Dashboard } from "./pages/Dashboard";
import { Chat } from "./pages/chat/ChatPage";
import { Projects } from "./pages/Projects";
import { Agents } from "./pages/Agents";
import { Logs } from "./pages/Logs";
import { TaskDetail } from "./pages/TaskDetail";
import { Channels } from "./pages/Channels";
import { Integrations } from "./pages/Integrations";
import { MCP } from "./pages/MCP";
import { Skills } from "./pages/Skills";
import { Security } from "./pages/Security";
import { Costs } from "./pages/Costs";
import { Settings } from "./pages/Settings";
import { Cron } from "./pages/Cron";
import { Watchers } from "./pages/Watchers";
import { Files } from "./pages/Files";
import { Setup } from "./pages/Setup";

export const router = createBrowserRouter([
  {
    path: "/setup",
    Component: Setup,
  },
  {
    path: "/",
    Component: () => createElement(AuthGate, null, createElement(AppShell)),
    children: [
      // Chat is the landing (generic chat).
      { index: true, Component: Chat },
      { path: "projects", Component: Projects },
      { path: "agents", Component: Agents },
      { path: "dashboard", Component: Dashboard },
      // Chat alias kept for any existing links.
      { path: "chat", Component: Chat },
      { path: "logs", Component: Logs },
      { path: "logs/:id", Component: TaskDetail },
      { path: "tasks", Component: Logs },
      { path: "tasks/:id", Component: TaskDetail },
      { path: "config", Component: Settings },
      { path: "channels", Component: Channels },
      { path: "files", Component: Files },
      { path: "integrations", Component: Integrations },
      { path: "mcp", Component: MCP },
      { path: "skills", Component: Skills },
      { path: "cron", Component: Cron },
      { path: "watchers", Component: Watchers },
      { path: "security", Component: Security },
      { path: "costs", Component: Costs },
      { path: "settings", Component: Settings },
    ],
  },
]);
