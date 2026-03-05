import { useEffect, useState } from "react";
import { Users, Loader2, Trash2, Pause, Play, Pencil, RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";

interface Tenant {
  id: string;
  plan: string;
  status: string;
  suspendedReason?: string;
  maxCostPerTask?: number;
  maxDailyCost?: number;
  defaultModel?: string;
  allowedPaths?: string[];
  blockedPaths?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  mcpServers?: string[];
  modelRoutes?: Record<string, string>;
  notes?: string;
  taskCount?: number;
  totalCost?: number;
  lastSeen?: string;
  createdAt?: string;
}

export function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);
  const [editForm, setEditForm] = useState<Record<string, any>>({});

  const fetchTenants = async () => {
    try {
      const res = await fetch("/api/tenants");
      if (res.ok) {
        const data = await res.json();
        setTenants(data.tenants || []);
      }
    } catch (error) {
      console.error("Failed to fetch tenants", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleSuspend = async (id: string) => {
    const toastId = toast.loading("SUSPENDING TENANT...");
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(id)}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Suspended via UI" }),
      });
      if (res.ok) {
        toast.success("TENANT SUSPENDED", { id: toastId });
        fetchTenants();
      } else {
        const err = await res.json();
        toast.error(err.error || "FAILED TO SUSPEND", { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message, { id: toastId });
    }
  };

  const handleUnsuspend = async (id: string) => {
    const toastId = toast.loading("UNSUSPENDING TENANT...");
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(id)}/unsuspend`, { method: "POST" });
      if (res.ok) {
        toast.success("TENANT UNSUSPENDED", { id: toastId });
        fetchTenants();
      } else {
        const err = await res.json();
        toast.error(err.error || "FAILED TO UNSUSPEND", { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message, { id: toastId });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete tenant "${id}"? This cannot be undone.`)) return;
    const toastId = toast.loading("DELETING TENANT...");
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Tenant deleted", { id: toastId });
        fetchTenants();
      } else {
        const err = await res.json();
        toast.error(err.error || "FAILED TO DELETE", { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message, { id: toastId });
    }
  };

  const openEdit = (tenant: Tenant) => {
    setEditTenant(tenant);
    setEditForm({
      defaultModel: tenant.defaultModel || "",
      plan: tenant.plan || "free",
      maxCostPerTask: tenant.maxCostPerTask ?? "",
      maxDailyCost: tenant.maxDailyCost ?? "",
      allowedPaths: (tenant.allowedPaths || []).join(", "),
      blockedPaths: (tenant.blockedPaths || []).join(", "),
      allowedTools: (tenant.allowedTools || []).join(", "),
      blockedTools: (tenant.blockedTools || []).join(", "),
      mcpServers: (tenant.mcpServers || []).join(", "),
      modelRoutes: JSON.stringify(tenant.modelRoutes || {}, null, 2),
      notes: tenant.notes || "",
    });
  };

  const handleSaveEdit = async () => {
    if (!editTenant) return;
    const toastId = toast.loading("UPDATING TENANT...");
    const splitList = (s: string) => s ? s.split(",").map((v: string) => v.trim()).filter(Boolean) : [];
    try {
      let modelRoutes = {};
      try { modelRoutes = JSON.parse(editForm.modelRoutes || "{}"); } catch { /* ignore */ }

      const body: Record<string, any> = {
        defaultModel: editForm.defaultModel || undefined,
        plan: editForm.plan,
        notes: editForm.notes || undefined,
        allowedPaths: splitList(editForm.allowedPaths),
        blockedPaths: splitList(editForm.blockedPaths),
        allowedTools: splitList(editForm.allowedTools),
        blockedTools: splitList(editForm.blockedTools),
        mcpServers: splitList(editForm.mcpServers),
        modelRoutes,
      };
      if (editForm.maxCostPerTask !== "") body.maxCostPerTask = parseFloat(editForm.maxCostPerTask);
      if (editForm.maxDailyCost !== "") body.maxDailyCost = parseFloat(editForm.maxDailyCost);

      const res = await fetch(`/api/tenants/${encodeURIComponent(editTenant.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("TENANT UPDATED", { id: toastId });
        setEditTenant(null);
        fetchTenants();
      } else {
        const err = await res.json();
        toast.error(err.error || "FAILED TO UPDATE", { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message, { id: toastId });
    }
  };

  const planColor = (plan: string) => {
    switch (plan) {
      case "admin": return "text-red-400 border-red-500/30 bg-red-500/10";
      case "pro": return "text-[#00d9ff] border-[#00d9ff]/30 bg-[#00d9ff]/10";
      default: return "text-gray-400 border-slate-700 bg-slate-800/50";
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
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Tenants</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">USER & CHANNEL MANAGEMENT</p>
      </div>

      {/* Tenant Cards */}
      <div className="grid grid-cols-1 gap-4">
        {tenants.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-slate-800 rounded-xl bg-slate-900/20">
            <Users className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">NO TENANTS REGISTERED</p>
          </div>
        ) : (
          tenants.map((tenant) => (
            <Card
              key={tenant.id}
              className={`bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl transition-all border-l-4 ${
                tenant.status === "suspended" ? "border-l-amber-500" : "border-l-[#00ff88]"
              }`}
            >
              <CardHeader className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${
                      tenant.status === "suspended"
                        ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                        : "bg-[#00ff88] shadow-[0_0_8px_rgba(0,255,136,0.5)]"
                    }`} />
                    <div>
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-white font-mono text-lg uppercase tracking-tight">{tenant.id}</CardTitle>
                        <Badge variant="outline" className={`font-mono text-[9px] uppercase ${planColor(tenant.plan)}`}>
                          {tenant.plan}
                        </Badge>
                        {tenant.status === "suspended" && (
                          <Badge variant="outline" className="font-mono text-[9px] uppercase text-amber-500 border-amber-500/30 bg-amber-500/10">
                            Suspended
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono mt-1 flex items-center gap-4">
                        {tenant.totalCost != null && <span>Cost: ${tenant.totalCost.toFixed(4)}</span>}
                        {tenant.taskCount != null && <span>Tasks: {tenant.taskCount}</span>}
                        {tenant.lastSeen && <span>Last seen: {new Date(tenant.lastSeen).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(tenant)}
                      className="text-[#00d9ff] hover:bg-[#00d9ff]/10 font-mono text-[10px] uppercase"
                    >
                      <Pencil className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    {tenant.status === "suspended" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUnsuspend(tenant.id)}
                        className="text-[#00ff88] hover:bg-[#00ff88]/10 font-mono text-[10px] uppercase"
                      >
                        <Play className="w-3 h-3 mr-1" />
                        Unsuspend
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSuspend(tenant.id)}
                        className="text-amber-500 hover:bg-amber-500/10 font-mono text-[10px] uppercase"
                      >
                        <Pause className="w-3 h-3 mr-1" />
                        Suspend
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(tenant.id)}
                      className="text-red-500/70 hover:text-red-500 font-mono text-[10px] uppercase hover:bg-red-500/10"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Delete
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {(tenant.defaultModel || tenant.notes || (tenant.mcpServers && tenant.mcpServers.length > 0)) && (
                <CardContent className="pb-4 pt-0">
                  <div className="flex flex-wrap gap-3 text-[10px] font-mono text-gray-500">
                    {tenant.defaultModel && <span>Model: <span className="text-gray-300">{tenant.defaultModel}</span></span>}
                    {tenant.mcpServers && tenant.mcpServers.length > 0 && (
                      <span>MCP: <span className="text-gray-300">{tenant.mcpServers.join(", ")}</span></span>
                    )}
                    {tenant.notes && <span className="text-gray-400 italic">{tenant.notes}</span>}
                  </div>
                </CardContent>
              )}
            </Card>
          ))
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editTenant} onOpenChange={(open) => !open && setEditTenant(null)}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white border-2 shadow-[0_0_30px_rgba(0,217,255,0.1)] max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white uppercase font-bold tracking-widest border-b border-slate-800 pb-4">
              Edit Tenant: {editTenant?.id}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4 font-mono">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Default Model</label>
                <Input
                  value={editForm.defaultModel || ""}
                  onChange={(e) => setEditForm({ ...editForm, defaultModel: e.target.value })}
                  placeholder="e.g. gpt-4o"
                  className="bg-slate-900 border-slate-800 text-white text-xs"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Plan</label>
                <Select
                  value={editForm.plan || "free"}
                  onValueChange={(value) => setEditForm({ ...editForm, plan: value })}
                >
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800 text-white">
                    <SelectItem value="free" className="text-xs">FREE</SelectItem>
                    <SelectItem value="pro" className="text-xs">PRO</SelectItem>
                    <SelectItem value="admin" className="text-xs">ADMIN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Max Cost / Task</label>
                <Input
                  type="number"
                  step="0.01"
                  value={editForm.maxCostPerTask ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, maxCostPerTask: e.target.value })}
                  placeholder="e.g. 0.50"
                  className="bg-slate-900 border-slate-800 text-white text-xs"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Max Daily Cost</label>
                <Input
                  type="number"
                  step="0.01"
                  value={editForm.maxDailyCost ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, maxDailyCost: e.target.value })}
                  placeholder="e.g. 5.00"
                  className="bg-slate-900 border-slate-800 text-white text-xs"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Allowed Paths (comma-separated)</label>
              <Input
                value={editForm.allowedPaths || ""}
                onChange={(e) => setEditForm({ ...editForm, allowedPaths: e.target.value })}
                placeholder="/home/user, /tmp"
                className="bg-slate-900 border-slate-800 text-white text-xs"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Blocked Paths (comma-separated)</label>
              <Input
                value={editForm.blockedPaths || ""}
                onChange={(e) => setEditForm({ ...editForm, blockedPaths: e.target.value })}
                placeholder="/etc, /root"
                className="bg-slate-900 border-slate-800 text-white text-xs"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Allowed Tools (comma-separated)</label>
              <Input
                value={editForm.allowedTools || ""}
                onChange={(e) => setEditForm({ ...editForm, allowedTools: e.target.value })}
                placeholder="readFile, webSearch"
                className="bg-slate-900 border-slate-800 text-white text-xs"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Blocked Tools (comma-separated)</label>
              <Input
                value={editForm.blockedTools || ""}
                onChange={(e) => setEditForm({ ...editForm, blockedTools: e.target.value })}
                placeholder="shellExec, deleteFile"
                className="bg-slate-900 border-slate-800 text-white text-xs"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">MCP Servers (comma-separated)</label>
              <Input
                value={editForm.mcpServers || ""}
                onChange={(e) => setEditForm({ ...editForm, mcpServers: e.target.value })}
                placeholder="postgres-db, memory"
                className="bg-slate-900 border-slate-800 text-white text-xs"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Model Routes (JSON)</label>
              <Textarea
                value={editForm.modelRoutes || "{}"}
                onChange={(e) => setEditForm({ ...editForm, modelRoutes: e.target.value })}
                placeholder='{"code": "gpt-4o", "research": "claude-3.5-sonnet"}'
                className="bg-slate-900 border-slate-800 text-white text-xs font-mono min-h-[60px]"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Notes</label>
              <Input
                value={editForm.notes || ""}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                placeholder="Internal notes..."
                className="bg-slate-900 border-slate-800 text-white text-xs"
              />
            </div>

            <Button
              onClick={handleSaveEdit}
              className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white mt-4 uppercase tracking-tighter"
            >
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
