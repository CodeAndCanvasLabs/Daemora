/**
 * UI kit — shared, themed, responsive + animated primitives for the rebuilt
 * pages. Keeps every page consistent (dark theme, cyan/teal accents) without
 * re-implementing cards/toggles/headers per page.
 */

import { motion } from "motion/react";
import { Loader2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions, icon: Icon }: { title: string; description?: string; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
      <div className="flex items-start gap-3">
        {Icon && <div className="w-10 h-10 rounded-xl bg-[#00d9ff]/10 border border-[#00d9ff]/30 flex items-center justify-center shrink-0"><Icon className="w-5 h-5 text-[#00d9ff]" /></div>}
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-white">{title}</h1>
          {description && <p className="text-sm text-gray-400 mt-0.5 max-w-2xl">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "", onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
      onClick={onClick}
      className={`rounded-xl border border-slate-800/60 bg-slate-900/30 backdrop-blur-sm ${onClick ? "cursor-pointer hover:border-[#00d9ff]/40 transition-colors" : ""} ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function Grid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 ${className}`}>{children}</div>;
}

export function StatCard({ label, value, hint, accent = "#00d9ff" }: { label: string; value: ReactNode; hint?: string; accent?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent }}>{value}</div>
      {hint && <div className="text-xs text-gray-500 mt-1">{hint}</div>}
    </Card>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2" aria-pressed={checked}>
      <span className={`relative w-9 h-5 rounded-full transition-colors ${checked ? "bg-[#00d9ff]" : "bg-slate-700"}`}>
        <motion.span layout className="absolute top-0.5 w-4 h-4 rounded-full bg-white" animate={{ left: checked ? 18 : 2 }} transition={{ type: "tween", duration: 0.15 }} />
      </span>
      {label && <span className="text-sm text-gray-300">{label}</span>}
    </button>
  );
}

export function Btn({ children, onClick, variant = "primary", disabled, className = "", type = "button" }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "ghost" | "danger"; disabled?: boolean; className?: string; type?: "button" | "submit" }) {
  const styles = {
    primary: "bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-[#0a0f1a] hover:opacity-90",
    ghost: "border border-slate-700/70 text-gray-300 hover:border-[#00d9ff]/50 hover:text-[#00d9ff]",
    danger: "bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all active:scale-[0.98] disabled:opacity-40 ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }: { icon: LucideIcon; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-16">
      <div className="w-12 h-12 rounded-2xl bg-slate-800/60 border border-slate-700/60 flex items-center justify-center"><Icon className="w-6 h-6 text-gray-400" /></div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {hint && <p className="text-sm text-gray-400 max-w-sm">{hint}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 py-16 text-gray-400 text-sm"><Loader2 className="w-4 h-4 animate-spin text-[#00d9ff]" />{label}</div>;
}

export function Pill({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "ok" | "warn" | "off" }) {
  const t = { default: "border-slate-700 text-gray-300", ok: "border-[#00ff88]/30 text-[#00ff88]", warn: "border-[#ffaa00]/30 text-[#ffaa00]", off: "border-slate-700 text-gray-500" }[tone];
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wider ${t}`}>{children}</span>;
}
