import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Shield, Lock, Unlock, AlertTriangle, Eye, Loader2, FolderOpen, Plus, X, Save, CheckCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";

interface AuditStats {
  totalEvents: number;
  bySeverity: {
    info: number;
    warning: number;
    critical: number;
  };
  recentEvents: any[];
}

const TIER_INFO: Record<string, { label: string; desc: string; color: string }> = {
  minimal: { label: "MINIMAL", desc: "Read-only tools only", color: "text-[#00ff88]" },
  standard: { label: "STANDARD", desc: "Read + write + sandboxed commands", color: "text-[#00d9ff]" },
  full: { label: "FULL", desc: "All tools including dangerous ones", color: "text-[#ff4458]" },
};

function validatePath(p: string): string | null {
  if (!p.trim()) return "Path cannot be empty";
  if (!p.startsWith("/")) return "Path must be absolute (start with /)";
  if (p.includes("..")) return "Path cannot contain '..'";
  if (/[\x00-\x1f]/.test(p)) return "Path cannot contain control characters";
  return null;
}

function SaveBtn({ dirty, saving, saved, onSave }: { dirty: boolean; saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <button
      onClick={onSave}
      disabled={!dirty || saving}
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[10px] font-mono uppercase tracking-wider transition-all ${
        dirty
          ? "bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/40 hover:bg-[#00d9ff]/25 cursor-pointer shadow-[0_0_12px_rgba(0,217,255,0.1)]"
          : saved
          ? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30"
          : "bg-slate-800/50 text-gray-600 border border-slate-700/50 cursor-not-allowed"
      }`}
    >
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <CheckCircle className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
      {saving ? "Saving..." : saved ? "Saved" : "Save"}
    </button>
  );
}

function PathChips({
  paths,
  onRemove,
  variant = "default",
}: {
  paths: string[];
  onRemove: (i: number) => void;
  variant?: "default" | "danger";
}) {
  if (!paths.length) return <span className="text-[10px] text-gray-600 font-mono italic">None configured</span>;
  const chipColor = variant === "danger"
    ? "bg-red-500/10 border-red-500/30 text-red-400"
    : "bg-[#00d9ff]/10 border-[#00d9ff]/30 text-[#00d9ff]";
  return (
    <div className="flex flex-wrap gap-1.5">
      {paths.map((p, i) => (
        <span key={i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border ${chipColor}`}>
          {p}
          <button onClick={() => onRemove(i)} className="hover:text-white transition-colors ml-0.5">
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function Security() {
  const [vaultStatus, setVaultStatus] = useState({ exists: false, unlocked: false });
  const [audit, setAudit] = useState<AuditStats | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);

  // Security settings state
  const [permissionTier, setPermissionTier] = useState("standard");
  // Filesystem guard — backed by /api/security/fs (NOT /api/settings).
  // The four-mode contract is the single source of truth for FS access.
  const [fsMode, setFsMode] = useState<"off" | "moderate" | "strict" | "sandbox">("moderate");
  const [allowedPaths, setAllowedPaths] = useState<string[]>([]);
  const [blockedPaths, setBlockedPaths] = useState<string[]>([]);
  const [fsEffectiveAllow, setFsEffectiveAllow] = useState<string[]>([]);
  const [fsModeDoc, setFsModeDoc] = useState<Record<string, string>>({});
  const [newAllowedPath, setNewAllowedPath] = useState("");
  const [newBlockedPath, setNewBlockedPath] = useState("");
  const [secDirty, setSecDirty] = useState(false);
  const [secSaving, setSecSaving] = useState(false);
  const [secSaved, setSecSaved] = useState(false);

  const markDirty = () => { setSecDirty(true); setSecSaved(false); };

  const loadSettings = async () => {
    try {
      const [settingsRes, fsRes] = await Promise.all([
        apiFetch("/api/settings"),
        apiFetch("/api/security/fs"),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        const vars: Record<string, string> = data.vars || {};
        setPermissionTier(vars.PERMISSION_TIER || "standard");
      }
      if (fsRes.ok) {
        const fs = await fsRes.json();
        setFsMode((fs.mode as typeof fsMode) || "moderate");
        setAllowedPaths(Array.isArray(fs.allow) ? fs.allow : []);
        setBlockedPaths(Array.isArray(fs.deny) ? fs.deny : []);
        setFsEffectiveAllow(fs.effective?.allow ?? []);
        setFsModeDoc(fs.doc ?? {});
      }
    } catch (e) {
      console.error("Failed to load security settings", e);
    }
  };

  const fetchData = async () => {
    try {
      const [vaultRes, auditRes] = await Promise.all([
        apiFetch("/api/vault/status"),
        apiFetch("/api/audit"),
        loadSettings(),
      ]);
      if (vaultRes.ok) setVaultStatus(await vaultRes.json());
      if (auditRes.ok) setAudit(await auditRes.json());
    } catch (error) {
      console.error("Security data fetch failed", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleUnlock = async () => {
    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (res.ok) {
        sessionStorage.setItem("daemora_vault_pass", passphrase);
        toast.success("Vault unlocked successfully");
        setIsUnlockDialogOpen(false);
        setPassphrase("");
        fetchData();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "ACCESS DENIED");
      }
    } catch (err) {
      toast.error("Failed to unlock vault");
    }
  };

  const handleLock = async () => {
    try {
      const res = await apiFetch("/api/vault/lock", { method: "POST" });
      if (res.ok) {
        toast.success("Vault locked successfully");
        fetchData();
      }
    } catch (err) {
      toast.error("Failed to lock vault");
    }
  };

  const handleSaveSettings = async () => {
    setSecSaving(true);
    try {
      // Permission tier still goes through /api/settings (used by PermissionGuard).
      const tierRes = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { PERMISSION_TIER: permissionTier } }),
      });
      // Filesystem guard goes through /api/security/fs — the live guard
      // is hot-updated by the backend so changes take effect immediately.
      const fsRes = await apiFetch("/api/security/fs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: fsMode,
          allow: allowedPaths,
          deny: blockedPaths,
        }),
      });
      if (tierRes.ok && fsRes.ok) {
        setSecSaved(true);
        setSecDirty(false);
        toast.success("Security settings saved");
        await loadSettings();
      } else {
        const err = await (fsRes.ok ? tierRes : fsRes).json().catch(() => ({}));
        toast.error(err.error || "Failed to save settings");
      }
    } catch (e) {
      toast.error("Failed to save settings");
    } finally {
      setSecSaving(false);
    }
  };

  const addPath = (type: "allowed" | "blocked") => {
    const value = type === "allowed" ? newAllowedPath : newBlockedPath;
    const err = validatePath(value);
    if (err) { toast.error(err); return; }
    const normalized = value.trim();
    if (type === "allowed") {
      if (allowedPaths.includes(normalized)) { toast.error("Path already added"); return; }
      setAllowedPaths(prev => [...prev, normalized]);
      setNewAllowedPath("");
    } else {
      if (blockedPaths.includes(normalized)) { toast.error("Path already added"); return; }
      setBlockedPaths(prev => [...prev, normalized]);
      setNewBlockedPath("");
    }
    markDirty();
  };

  const removePath = (type: "allowed" | "blocked", index: number) => {
    if (type === "allowed") setAllowedPaths(prev => prev.filter((_, i) => i !== index));
    else setBlockedPaths(prev => prev.filter((_, i) => i !== index));
    markDirty();
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "info": return "text-[#00d9ff]";
      case "warning": return "text-[#ffaa00]";
      case "critical": return "text-[#ff4458]";
      default: return "text-gray-500";
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Security</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">VAULT · AUDIT · PERMISSIONS · SANDBOX</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Vault Status */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Shield className="w-6 h-6 text-[#00d9ff]" />
              <div>
                <CardTitle className="text-white uppercase tracking-tight">Secret Vault</CardTitle>
                <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                  ENCRYPTED CREDENTIAL STORAGE
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-6 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-4">
                {!vaultStatus.unlocked ? (
                  <div className="relative">
                    <Lock className="w-10 h-10 text-[#ff4458]" />
                    <div className="absolute inset-0 animate-ping bg-[#ff4458]/20 rounded-full scale-150 opacity-20" />
                  </div>
                ) : (
                  <Unlock className="w-10 h-10 text-[#00ff88]" />
                )}
                <div>
                  <div className="font-mono font-bold text-xl text-white uppercase tracking-wider">
                    {vaultStatus.unlocked ? "SYSTEM UNLOCKED" : "ENCRYPTED"}
                  </div>
                  <div className="text-[10px] text-gray-500 font-mono uppercase tracking-widest mt-1">
                    {vaultStatus.unlocked
                      ? "Secrets loaded into memory"
                      : "AES-256-GCM Protection Active"}
                  </div>
                </div>
              </div>

              {!vaultStatus.unlocked ? (
                <Dialog open={isUnlockDialogOpen} onOpenChange={setIsUnlockDialogOpen}>
                  <DialogTrigger asChild>
                    <Button className="bg-[#ff4458] hover:bg-red-600 text-white font-mono text-xs uppercase tracking-widest px-6 shadow-[0_0_20px_rgba(255,68,88,0.2)]">
                      Decrypt
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="bg-slate-950 border-slate-800 text-white font-mono">
                    <DialogHeader>
                      <DialogTitle className="uppercase tracking-widest text-sm border-b border-slate-800 pb-4">Auth Required</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 pt-4">
                      <div className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                        <p className="text-[10px] text-gray-400 uppercase leading-relaxed">
                          Enter master passphrase to unlock API credentials. Multi-factor verification active.
                        </p>
                      </div>
                      <Input
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                        placeholder="PASSPHRASE..."
                        className="bg-slate-900 border-slate-800 text-[#00ff88] text-center tracking-[0.5em]"
                      />
                      <Button
                        onClick={handleUnlock}
                        disabled={!passphrase}
                        className="w-full bg-white text-black hover:bg-gray-200 uppercase text-xs font-bold"
                      >
                        Execute Decryption
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              ) : (
                <Button
                  onClick={handleLock}
                  variant="outline"
                  className="border-slate-700 text-gray-400 hover:text-white font-mono text-xs uppercase"
                >
                  <Lock className="w-4 h-4 mr-2" />
                  Purge Keys
                </Button>
              )}
            </div>

            <div className="p-4 bg-slate-950/50 border border-slate-800 rounded-lg">
              <h4 className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-3">Security Parameters</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[9px] text-gray-600 uppercase mb-1">Local Mode</div>
                  <Badge variant="outline" className="border-[#00ff88]/30 text-[#00ff88] font-mono text-[10px]">ENFORCED</Badge>
                </div>
                <div>
                  <div className="text-[9px] text-gray-600 uppercase mb-1">Vault Status</div>
                  <Badge variant="outline" className="border-slate-800 text-gray-400 font-mono text-[10px]">{vaultStatus.exists ? 'PERSISTED' : 'NOT FOUND'}</Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Audit Log */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl h-full flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Eye className="w-6 h-6 text-[#7C6AFF]" />
              <div>
                <CardTitle className="text-white uppercase tracking-tight">Audit Log</CardTitle>
                <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                  SECURITY EVENTS
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-hidden p-0">
            <ScrollArea className="h-[400px] px-6">
              <div className="space-y-4 py-6">
                {!audit || !audit.recentEvents || audit.recentEvents.length === 0 ? (
                  <div className="text-center py-20 text-gray-700 font-mono uppercase text-[10px] tracking-widest italic">No security events logged</div>
                ) : (
                  audit.recentEvents.map((entry: any, i: number) => (
                    <div
                      key={i}
                      className="p-3 bg-slate-800/20 border border-slate-800/50 rounded-lg font-mono"
                    >
                      <div className="flex items-start justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <div className={`w-1.5 h-1.5 rounded-full ${entry.level === 'critical' ? 'bg-red-500' : entry.level === 'warning' ? 'bg-amber-500' : 'bg-[#00d9ff]'}`} />
                          <span className="text-[10px] font-bold text-white uppercase tracking-tight">{entry.type}</span>
                        </div>
                        <Badge variant="outline" className={`text-[8px] h-4 uppercase ${getSeverityColor(entry.level)} border-current opacity-50`}>
                          {entry.level}
                        </Badge>
                      </div>
                      <p className="text-[10px] text-gray-400 leading-relaxed lowercase mb-2">{entry.message}</p>
                      <div className="text-[8px] text-gray-600 uppercase tracking-tighter">
                        {new Date(entry.timestamp).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Permission & Sandbox */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
        <CardHeader>
          <div className="flex items-center gap-3">
            <FolderOpen className="w-6 h-6 text-[#ffaa00]" />
            <div>
              <CardTitle className="text-white uppercase tracking-tight">Permission & Sandbox</CardTitle>
              <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                GLOBAL DEFAULTS
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Permission Tier */}
          <div className="p-4 bg-slate-800/30 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-mono text-white uppercase tracking-wider">Permission Tier</h4>
                <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                  {TIER_INFO[permissionTier]?.desc || "Controls which tools the agent can use"}
                </p>
              </div>
              <Select value={permissionTier} onValueChange={(v) => { setPermissionTier(v); markDirty(); }}>
                <SelectTrigger className="w-[160px] bg-slate-950 border-slate-700 text-white font-mono text-[10px] uppercase h-8">
                  <SelectValue placeholder="STANDARD" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-700">
                  {Object.entries(TIER_INFO).map(([key, info]) => (
                    <SelectItem key={key} value={key} className={`font-mono text-[10px] uppercase ${info.color}`}>
                      {info.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Filesystem Guard — drives /api/security/fs (real, hot-updated) */}
          <div className="p-4 bg-slate-800/30 border border-slate-800 rounded-xl space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <h4 className="text-xs font-mono text-white uppercase tracking-wider">Filesystem Guard</h4>
                <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                  {fsModeDoc[fsMode] || "Controls which paths the agent can read, write, or execute"}
                </p>
              </div>
              <Select value={fsMode} onValueChange={(v) => { setFsMode(v as typeof fsMode); markDirty(); }}>
                <SelectTrigger className="w-[160px] bg-slate-950 border-slate-700 text-white font-mono text-[10px] uppercase h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-700">
                  <SelectItem value="off" className="font-mono text-[10px] uppercase text-gray-400">OFF</SelectItem>
                  <SelectItem value="moderate" className="font-mono text-[10px] uppercase text-[#00d9ff]">MODERATE</SelectItem>
                  <SelectItem value="strict" className="font-mono text-[10px] uppercase text-[#ffaa00]">STRICT</SelectItem>
                  <SelectItem value="sandbox" className="font-mono text-[10px] uppercase text-[#ff4458]">SANDBOX</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Allowed Paths — only meaningful in strict / sandbox */}
            {(fsMode === "strict" || fsMode === "sandbox") && (
              <div className="space-y-2">
                <div className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">
                  Allowed Paths {fsMode === "sandbox" ? "(only these are reachable)" : "(in addition to $HOME)"}
                </div>
                <PathChips paths={allowedPaths} onRemove={(i) => removePath("allowed", i)} />
                <div className="flex gap-2">
                  <Input
                    value={newAllowedPath}
                    onChange={(e) => setNewAllowedPath(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPath("allowed")}
                    placeholder="/path/to/allow"
                    className="bg-slate-950 border-slate-700 text-white font-mono text-xs h-8 flex-1"
                  />
                  <Button
                    onClick={() => addPath("allowed")}
                    size="sm"
                    className="bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/25 h-8 px-3"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}

            {/* Blocked Paths — applies to moderate/strict/sandbox (not off) */}
            {fsMode !== "off" && (
              <div className="space-y-2">
                <div className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">
                  Extra Blocked Paths
                </div>
                <PathChips paths={blockedPaths} onRemove={(i) => removePath("blocked", i)} variant="danger" />
                <div className="flex gap-2">
                  <Input
                    value={newBlockedPath}
                    onChange={(e) => setNewBlockedPath(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPath("blocked")}
                    placeholder="/path/to/block"
                    className="bg-slate-950 border-slate-700 text-white font-mono text-xs h-8 flex-1"
                  />
                  <Button
                    onClick={() => addPath("blocked")}
                    size="sm"
                    className="bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 h-8 px-3"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <p className="text-[10px] text-gray-600 font-mono">
                  ~/.ssh, ~/.aws, /etc are always blocked in moderate/strict/sandbox.
                </p>
              </div>
            )}

            {/* Effective view — what the live guard is enforcing right now */}
            {fsEffectiveAllow.length > 0 && (
              <details className="text-[10px] font-mono text-gray-500">
                <summary className="cursor-pointer hover:text-gray-300">Effective allow-list (resolved)</summary>
                <ul className="mt-2 space-y-0.5 pl-4">
                  {fsEffectiveAllow.map((p) => <li key={p}>· {p}</li>)}
                </ul>
              </details>
            )}
          </div>
        </CardContent>
      </Card>


      {/* Global Save Button */}
      {(secDirty || secSaved) && (
        <div className="flex justify-end">
          <SaveBtn dirty={secDirty} saving={secSaving} saved={secSaved} onSave={handleSaveSettings} />
        </div>
      )}
    </div>
  );
}
