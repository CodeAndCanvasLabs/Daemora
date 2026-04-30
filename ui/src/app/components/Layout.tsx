import { Outlet, Link, useLocation, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { StarField } from "./StarField";
import { Logo } from "./ui/Logo";
import {
  Terminal,
  ScrollText,
  SlidersHorizontal,
  Network,
  Flame,
  Boxes,
  ShieldAlert,
  CircuitBoard,
  Fingerprint,
  Settings,
  Radio,
  Timer,
  Puzzle,
  Target,
  Eye,
  Plug,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const SIDEBAR_STORAGE_KEY = "daemora_sidebar_collapsed";

const navItems = [
  { path: "/", label: "Dashboard", icon: CircuitBoard },
  { path: "/chat", label: "Chat", icon: Terminal },
  { path: "/logs", label: "Logs", icon: ScrollText },
  { path: "/channels", label: "Channels", icon: Radio },
  { path: "/integrations", label: "Integrations", icon: Plug },
  { path: "/mcp", label: "MCP", icon: Network },
  { path: "/skills", label: "Skills", icon: Flame },
  { path: "/cron", label: "Scheduler", icon: Timer },
  { path: "/goals", label: "Goals", icon: Target },
  { path: "/watchers", label: "Watchers", icon: Eye },
  { path: "/security", label: "Security", icon: ShieldAlert },
  { path: "/costs", label: "Costs", icon: Fingerprint },
  { path: "/crew", label: "Crew", icon: Puzzle },
  { path: "/teams", label: "Teams", icon: Boxes },
  { path: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [vaultPass, setVaultPass] = useState("");
  const [vaultError, setVaultError] = useState("");
  const [vaultLoading, setVaultLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1"; } catch { return false; }
  });

  const toggleSidebar = (): void => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch("/api/setup/status");
        const data = r.ok ? await r.json() : null;
        if (data && !data.completed) {
          navigate("/setup", { replace: true });
          setReady(true);
          return;
        }
        if (data?.vaultExists && !data?.vaultUnlocked) {
          // The passphrase is the credential — hitting /auth/login
          // runs LocalAuthProvider which unlocks the vault AND refreshes
          // the JWT in one shot. tsx watch drops both on restart, so we
          // re-derive from sessionStorage silently if available.
          const cached = sessionStorage.getItem("daemora_vault_pass");
          if (cached) {
            try {
              const ur = await apiFetch("/auth/login", {
                method: "POST",
                body: JSON.stringify({ passphrase: cached }),
              });
              if (!ur.ok) setVaultLocked(true);
            } catch {
              setVaultLocked(true);
            }
          } else {
            setVaultLocked(true);
          }
        }
        setReady(true);
      } catch {
        setReady(true);
      }
    })();
  }, []);

  const unlockVault = async () => {
    if (!vaultPass) return;
    setVaultLoading(true);
    setVaultError("");
    try {
      // Single entry point: /auth/login runs through LocalAuthProvider
      // which verifies the passphrase by unlocking the vault, then
      // issues a fresh JWT. One call covers auth + vault.
      const res = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ passphrase: vaultPass }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Wrong passphrase");
      }
      sessionStorage.setItem("daemora_vault_pass", vaultPass);
      setVaultLocked(false);
      setVaultPass("");
      // Wake word is opt-in (not auto-started) to prevent mic conflict with voice session
    } catch (e: any) {
      setVaultError(e.message || "Failed");
    }
    setVaultLoading(false);
  };

  if (!ready) return null;

  if (vaultLocked) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="w-full max-w-sm px-6 flex flex-col items-center gap-5">
          <Logo size={48} />
          <h1 className="text-xl font-bold tracking-[2px] bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent">
            DAEMORA
          </h1>
          <div className="text-center">
            <p className="text-sm text-[#6b7a8d]">Enter vault passphrase to unlock API keys</p>
          </div>
          <div className="w-full flex flex-col gap-3">
            <input
              type="password"
              value={vaultPass}
              onChange={(e) => setVaultPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlockVault()}
              placeholder="Vault passphrase"
              className="w-full px-4 py-3 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] transition-colors"
              autoFocus
            />
            {vaultError && <p className="text-xs text-red-400 text-center">{vaultError}</p>}
            <button
              onClick={unlockVault}
              disabled={vaultLoading || !vaultPass}
              className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40"
            >
              {vaultLoading ? "Unlocking..." : "Unlock"}
            </button>
            <button
              onClick={() => setVaultLocked(false)}
              className="text-xs text-[#4a5568] hover:text-[#6b7a8d] underline"
            >
              Skip — continue without API keys
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#030213] text-[#f0f0f3] relative overflow-hidden flex">
      <StarField />

      {/* Atmospheric Glow */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-[#00d9ff] opacity-10 blur-[128px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-96 h-96 bg-[#4ECDC4] opacity-10 blur-[128px] rounded-full pointer-events-none" />

      {/* Sidebar */}
      <aside
        className={`relative border-r border-slate-800/50 bg-slate-900/20 backdrop-blur-xl z-20 flex flex-col h-screen sticky top-0 transition-[width] duration-200 ease-out ${
          sidebarCollapsed ? "w-16" : "w-64"
        }`}
      >
        {/* Collapse handle — sits on the right edge so it's always
            reachable regardless of state. */}
        <button
          type="button"
          onClick={toggleSidebar}
          className="absolute -right-3 top-7 z-30 w-6 h-6 rounded-full bg-slate-900 border border-slate-700 hover:border-[#00d9ff]/60 hover:bg-slate-800 flex items-center justify-center text-gray-400 hover:text-[#00d9ff] transition-colors shadow-lg"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
        </button>

        <div className={`border-b border-slate-800/50 ${sidebarCollapsed ? "py-5 px-3 flex justify-center" : "p-6"}`}>
          <div className={`flex items-center ${sidebarCollapsed ? "justify-center" : "gap-3"}`}>
            <Logo size={sidebarCollapsed ? 32 : 40} />
            {!sidebarCollapsed && (
              <h1 className="text-xl font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent tracking-tight">
                Daemora
              </h1>
            )}
          </div>
        </div>

        <nav className={`space-y-1 flex-1 overflow-y-auto ${sidebarCollapsed ? "p-2" : "p-4"}`}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path || (item.path !== "/" && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                title={sidebarCollapsed ? item.label : undefined}
                className={`flex items-center rounded-lg transition-all ${
                  sidebarCollapsed ? "justify-center px-0 py-2.5" : "gap-3 px-4 py-3"
                } ${
                  isActive
                    ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30 shadow-[0_0_15px_rgba(0,217,255,0.2)]"
                    : "text-gray-400 hover:bg-slate-800/50 hover:text-[#00d9ff]"
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span className="font-medium text-sm">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className={`border-t border-slate-800/50 ${sidebarCollapsed ? "py-3 flex justify-center" : "p-4"}`}>
          <div className={`flex items-center ${sidebarCollapsed ? "justify-center" : "gap-2 px-4 py-2"}`}>
            <div className="w-2 h-2 bg-[#00ff88] rounded-full animate-pulse" title="System Active" />
            {!sidebarCollapsed && (
              <span className="text-[10px] text-gray-500 font-mono uppercase tracking-widest">System Active</span>
            )}
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
        <main className={`flex-1 overflow-y-auto ${location.pathname === "/chat" ? "" : "p-6"}`}>
          <div className={`h-full ${location.pathname === "/chat" ? "" : "max-w-[1600px] mx-auto"}`}>
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
