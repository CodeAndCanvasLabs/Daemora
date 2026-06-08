/**
 * AppShell — the rebuilt application chrome (Phase 1).
 *
 * New information architecture (Projects-as-spine, single user organizing their
 * own work):
 *   Primary:  Chat (generic) · Projects · Agents
 *   Manage:   Channels · Integrations · MCP · Skills · Scheduler · Goals ·
 *             Watchers · Security · Costs · Overview   (collapsible group)
 *   Settings  (pinned bottom)
 *
 * Responsive: a fixed sidebar on md+, an overlay drawer on mobile. Keeps the
 * dark theme + cyan/teal accents; drops the noisy "AUTHORIZED ACCESS" banner for
 * a clean topbar. Vault-unlock + setup-redirect logic is preserved verbatim.
 */

import { Outlet, Link, useLocation, useNavigate } from "react-router";
import { useEffect, useState, type ComponentType } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  MessageSquare, FolderKanban, Bot, Radio, Plug, Network, Flame, Timer,
  Target, Eye, ShieldAlert, Fingerprint, LayoutDashboard, Settings as SettingsIcon,
  ChevronDown, Menu,
} from "lucide-react";

import { apiFetch } from "../api";
import { StarField } from "./StarField";
import { Logo } from "./ui/Logo";

interface NavItem { path: string; label: string; icon: ComponentType<{ className?: string }>; }

const PRIMARY: NavItem[] = [
  { path: "/", label: "Chat", icon: MessageSquare },
  { path: "/projects", label: "Projects", icon: FolderKanban },
  { path: "/agents", label: "Agents", icon: Bot },
];

const MANAGE: NavItem[] = [
  { path: "/channels", label: "Channels", icon: Radio },
  { path: "/mcp", label: "MCP", icon: Network },
  { path: "/skills", label: "Skills", icon: Flame },
  { path: "/cron", label: "Scheduler", icon: Timer },
  { path: "/security", label: "Security", icon: ShieldAlert },
  { path: "/costs", label: "Costs", icon: Fingerprint },
  { path: "/dashboard", label: "Overview", icon: LayoutDashboard },
];

const PAGE_TITLES: Record<string, string> = {
  "/": "Chat",
  "/projects": "Projects",
  "/agents": "Agents",
  "/channels": "Channels",
  "/integrations": "Integrations",
  "/mcp": "MCP",
  "/skills": "Skills",
  "/cron": "Scheduler",
  "/goals": "Goals",
  "/watchers": "Watchers",
  "/security": "Security",
  "/costs": "Costs",
  "/dashboard": "Overview",
  "/settings": "Settings",
};

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [vaultPass, setVaultPass] = useState("");
  const [vaultError, setVaultError] = useState("");
  const [vaultLoading, setVaultLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(true);

  // ── Setup redirect + vault unlock (preserved from the previous Layout) ──
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
          const cached = sessionStorage.getItem("daemora_vault_pass");
          if (cached) {
            try {
              const ur = await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ passphrase: cached }) });
              if (!ur.ok) setVaultLocked(true);
            } catch { setVaultLocked(true); }
          } else {
            setVaultLocked(true);
          }
        }
        setReady(true);
      } catch {
        setReady(true);
      }
    })();
  }, [navigate]);

  // Close the mobile drawer on navigation.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  const unlockVault = async () => {
    if (!vaultPass) return;
    setVaultLoading(true);
    setVaultError("");
    try {
      const res = await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ passphrase: vaultPass }) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Wrong passphrase");
      }
      sessionStorage.setItem("daemora_vault_pass", vaultPass);
      setVaultLocked(false);
      setVaultPass("");
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : "Failed");
    }
    setVaultLoading(false);
  };

  if (!ready) return null;

  if (vaultLocked) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="w-full max-w-sm px-6 flex flex-col items-center gap-5">
          <Logo size={48} />
          <h1 className="text-xl font-bold tracking-[2px] bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent">DAEMORA</h1>
          <p className="text-sm text-[#6b7a8d] text-center">Enter vault passphrase to unlock API keys</p>
          <div className="w-full flex flex-col gap-3">
            <input
              type="password" value={vaultPass} onChange={(e) => setVaultPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlockVault()} placeholder="Vault passphrase" autoFocus
              className="w-full px-4 py-3 bg-[#131b2e] border border-[#1e2d45] rounded-lg text-white font-mono text-sm outline-none focus:border-[#00d9ff] transition-colors"
            />
            {vaultError && <p className="text-xs text-red-400 text-center">{vaultError}</p>}
            <button onClick={unlockVault} disabled={vaultLoading || !vaultPass}
              className="w-full py-3 bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] font-bold rounded-lg text-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40">
              {vaultLoading ? "Unlocking..." : "Unlock"}
            </button>
            <button onClick={() => setVaultLocked(false)} className="text-xs text-[#4a5568] hover:text-[#6b7a8d] underline">
              Skip — continue without API keys
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname === path || location.pathname.startsWith(`${path}/`);

  const NavLink = ({ item }: { item: NavItem }) => {
    const Icon = item.icon;
    const active = isActive(item.path);
    return (
      <Link
        to={item.path}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${
          active
            ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30 shadow-[0_0_15px_rgba(0,217,255,0.15)]"
            : "text-gray-400 hover:bg-slate-800/50 hover:text-[#00d9ff] border border-transparent"
        }`}
      >
        <Icon className="w-[18px] h-[18px] shrink-0" />
        <span>{item.label}</span>
      </Link>
    );
  };

  const SidebarBody = (
    <>
      <div className="px-5 py-5 border-b border-slate-800/50 flex items-center gap-3">
        <Logo size={34} />
        <h1 className="text-lg font-bold bg-gradient-to-r from-white via-[#00d9ff] to-[#4ECDC4] bg-clip-text text-transparent tracking-tight">Daemora</h1>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {PRIMARY.map((i) => <NavLink key={i.path} item={i} />)}

        <button
          type="button" onClick={() => setManageOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 pt-4 pb-1 text-[10px] uppercase tracking-[0.2em] text-gray-600 hover:text-gray-400"
        >
          <span>Manage</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${manageOpen ? "" : "-rotate-90"}`} />
        </button>
        {manageOpen && MANAGE.map((i) => <NavLink key={i.path} item={i} />)}
      </nav>

      <div className="p-3 border-t border-slate-800/50">
        <NavLink item={{ path: "/settings", label: "Settings", icon: SettingsIcon }} />
        <div className="flex items-center gap-2 px-3 py-2 mt-1">
          <div className="w-2 h-2 bg-[#00ff88] rounded-full animate-pulse" />
          <span className="text-[10px] text-gray-500 font-mono uppercase tracking-widest">System Active</span>
        </div>
      </div>
    </>
  );

  const onChat = location.pathname === "/";

  return (
    <div className="min-h-screen bg-[#030213] text-[#f0f0f3] relative overflow-hidden flex">
      <StarField />
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-[#00d9ff] opacity-10 blur-[128px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-96 h-96 bg-[#4ECDC4] opacity-10 blur-[128px] rounded-full pointer-events-none" />

      {/* Desktop sidebar */}
      <aside className="hidden md:flex relative z-20 w-60 flex-col h-screen sticky top-0 border-r border-slate-800/50 bg-slate-900/20 backdrop-blur-xl">
        {SidebarBody}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <div className="md:hidden fixed inset-0 z-40">
            <motion.div
              className="absolute inset-0 bg-black/60"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              className="absolute left-0 top-0 h-full w-64 flex flex-col bg-slate-900/95 backdrop-blur-xl border-r border-slate-800/50"
              initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }}
              transition={{ type: "tween", duration: 0.22, ease: "easeOut" }}
            >
              {SidebarBody}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className="flex-1 flex flex-col relative z-10 h-screen overflow-hidden">
        <header className="h-14 border-b border-slate-800/50 bg-slate-900/10 backdrop-blur-md flex items-center justify-between px-4 md:px-6 shrink-0">
          <div className="flex items-center gap-3">
            <button className="md:hidden text-gray-400 hover:text-[#00d9ff]" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
              <Menu className="w-5 h-5" />
            </button>
            {/* Page title lives in each page's PageHeader — no duplicate here.
                Keep a label only on mobile, where the PageHeader scrolls away. */}
            <span className="md:hidden text-sm font-semibold text-gray-200">{PAGE_TITLES[location.pathname] ?? "Daemora"}</span>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[#00ff88]/20 text-[#00ff88] font-mono text-[9px] uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00ff88] animate-pulse" /> Live
          </span>
        </header>

        <main className={`flex-1 overflow-y-auto ${onChat ? "" : "p-4 md:p-6"}`}>
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className={onChat ? "h-full" : "h-full max-w-[1600px] mx-auto"}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
