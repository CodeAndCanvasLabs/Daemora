import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { login, session } from "../auth";

/**
 * Gate wrapping the authenticated app. Checks the vault state on mount:
 *   - If the vault doesn't exist yet → redirect to /setup.
 *   - If it exists but is locked → try sessionStorage auto-unlock once,
 *     otherwise render the unlock modal.
 *   - If it's unlocked → render the app.
 *
 * There are no user accounts in Daemora — the vault passphrase IS the
 * credential. Once unlocked, the vault stays unlocked until the server
 * process ends (or the user explicitly locks it).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "ok" | "locked" | "error">("loading");
  const [passphrase, setPassphrase] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const s = await session().catch(() => null);
    if (!s) { setStatus("error"); return; }
    if (!s.exists) {
      navigate("/setup", { replace: true });
      return;
    }
    if (s.unlocked) { setStatus("ok"); return; }

    // Try silent unlock from sessionStorage (tsx-watch restart path).
    const cached = (() => { try { return sessionStorage.getItem("daemora_vault_pass"); } catch { return null; } })();
    if (cached) {
      try {
        const after = await login(cached);
        if (after?.unlocked) { setStatus("ok"); return; }
      } catch { /* fall through to manual unlock */ }
    }
    setStatus("locked");
  };

  useEffect(() => { void refresh(); }, []);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!passphrase) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await login(passphrase);
      if (s.unlocked) {
        setPassphrase("");
        setStatus("ok");
      } else {
        setErr("Vault did not unlock.");
      }
    } catch (e) {
      setErr((e as Error).message || "Unlock failed");
    } finally {
      setBusy(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center text-[10px] text-gray-600 font-mono uppercase tracking-widest">
        Loading…
      </div>
    );
  }

  if (status === "locked") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-sm rounded-xl border border-slate-800/70 bg-slate-900/60 p-6 font-mono">
          <h2 className="text-sm font-semibold text-white mb-1">Vault locked</h2>
          <p className="text-[11px] text-gray-500 mb-4 leading-relaxed">
            Enter your vault passphrase. It stays unlocked in memory until the Daemora server stops.
          </p>
          <form onSubmit={onSubmit} className="space-y-3">
            <input
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="passphrase"
              className="w-full px-3 py-2 text-[13px] rounded bg-slate-950/60 border border-slate-800/80 text-white focus:outline-none focus:border-[#00d9ff]/50"
            />
            {err && <div className="text-[11px] text-red-400">{err}</div>}
            <button
              type="submit"
              disabled={busy || !passphrase}
              className="w-full px-3 py-2 text-[11px] uppercase tracking-widest rounded bg-[#00d9ff]/10 border border-[#00d9ff]/40 text-[#00d9ff] hover:bg-[#00d9ff]/20 disabled:opacity-40"
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center text-[10px] text-red-400 font-mono uppercase tracking-widest">
        Server unreachable. Check the Daemora process.
      </div>
    );
  }

  return <>{children}</>;
}
