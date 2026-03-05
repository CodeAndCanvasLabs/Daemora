import { Outlet, Link, useLocation } from "react-router";
import { StarField } from "./StarField";
import { Logo } from "./ui/Logo";
import {
  MessageSquare,
  ListTodo,
  Settings,
  Boxes,
  Sparkles,
  Shield,
  DollarSign,
  LayoutDashboard,
  Users,
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
  { path: "/tenants", label: "Tenants", icon: Users },
];

export function Layout() {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-[#030213] text-[#f0f0f3] relative overflow-hidden flex">
      <StarField />

      {/* Atmospheric Glow */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-[#00d9ff] opacity-10 blur-[128px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-96 h-96 bg-[#4ECDC4] opacity-10 blur-[128px] rounded-full pointer-events-none" />

      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800/50 bg-slate-900/20 backdrop-blur-xl z-20 flex flex-col h-screen sticky top-0">
        <div className="p-6 border-b border-slate-800/50">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <h1 className="text-xl font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent tracking-tight">
              Daemora
            </h1>
          </div>
        </div>
        
        <nav className="p-4 space-y-1 flex-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path || (item.path !== "/" && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                  isActive
                    ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30 shadow-[0_0_15px_rgba(0,217,255,0.2)]"
                    : "text-gray-400 hover:bg-slate-800/50 hover:text-[#00d9ff]"
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium text-sm">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/50">
          <div className="flex items-center gap-2 px-4 py-2">
            <div className="w-2 h-2 bg-[#00ff88] rounded-full animate-pulse" />
            <span className="text-[10px] text-gray-500 font-mono uppercase tracking-widest">System Active</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative z-10 h-screen overflow-hidden">
        {/* Simplified Header */}
        <header className="h-16 border-b border-slate-800/50 bg-slate-900/10 backdrop-blur-md flex items-center justify-between px-8 shrink-0">
          <div className="text-[10px] text-gray-500 font-mono uppercase tracking-[0.3em]">
            Authorized Access Only // Layer 7 Encryption
          </div>
          <div className="flex items-center gap-4">
            <Badge variant="outline" className="border-[#00ff88]/20 text-[#00ff88] font-mono text-[9px] h-5 uppercase">Live</Badge>
          </div>
        </header>

        {/* Dynamic Page Content */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-[1600px] mx-auto h-full">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Badge({ children, variant, className }: any) {
  return (
    <span className={`inline-flex items-center px-2 rounded-full border text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}
