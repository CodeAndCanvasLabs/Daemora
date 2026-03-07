import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Shield, Lock, Unlock, AlertTriangle, Eye, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
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

export function Security() {
  const [vaultStatus, setVaultStatus] = useState({ exists: false, unlocked: false });
  const [audit, setAudit] = useState<AuditStats | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);

  const fetchData = async () => {
    try {
      const [vaultRes, auditRes] = await Promise.all([
        apiFetch("/api/vault/status"),
        apiFetch("/api/audit")
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
      const res = await apiFetch("/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (res.ok) {
        toast.success("Vault unlocked successfully");
        setIsUnlockDialogOpen(false);
        setPassphrase("");
        fetchData();
      } else {
        const err = await res.json();
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
        <p className="text-gray-400 font-mono text-sm tracking-widest">VAULT & AUDIT LOG</p>
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
    </div>
  );
}
