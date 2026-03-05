import { Outlet, Link, useLocation } from "react-router";
import { StarField } from "./StarField";
import {
  MessageSquare,
  ListTodo,
  Settings,
  Boxes,
  Sparkles,
  Shield,
  DollarSign,
  LayoutDashboard,
  Activity,
} from "lucide-react";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/chat", label: "Chat", icon: MessageSquare },
  { path: "/tasks", label: "Tasks", icon: ListTodo },
  { path: "/mcp", label: "MCP", icon: Boxes },
  { path: "/skills", label: "Skills", icon: Sparkles },
  { path: "/config", label: "Config", icon: Settings },
  { path: "/security", label: "Security", icon: Shield },
  { path: "/costs", label: "Costs", icon: DollarSign },
];

export function Layout() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-slate-950 text-[#f0f0f3] relative overflow-hidden">
      <StarField />

      {/* Atmospheric Glow */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-[#00d9ff] opacity-20 blur-[128px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-96 h-96 bg-[#4ECDC4] opacity-15 blur-[128px] rounded-full pointer-events-none" />

      {/* Main Background */}
      <div className="absolute inset-0 bg-[#030213] pointer-events-none" style={{ zIndex: -1 }} />

      {/* Header */}
      <header className="relative z-10 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <Activity className="w-8 h-8 text-[#00d9ff]" />
              <h1 className="text-2xl font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent">
                Daemora
              </h1>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="w-2 h-2 bg-[#00ff88] rounded-full animate-pulse" />
              <span className="text-sm text-[#00ff88]">Connected</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex relative z-10">
        {/* Sidebar */}
        <aside className="w-64 border-r border-slate-800 bg-slate-900/30 backdrop-blur-sm min-h-[calc(100vh-73px)]">
          <nav className="p-4 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                    isActive
                      ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30 shadow-[0_0_15px_rgba(0,217,255,0.3)]"
                      : "text-gray-400 hover:bg-slate-800/50 hover:text-[#00d9ff]"
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8">
          <div className="max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
