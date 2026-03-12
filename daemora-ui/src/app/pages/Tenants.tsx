import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Users, Loader2, Trash2, Pause, Play, Pencil, RotateCcw, Key, Plus, X, Eye, EyeOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from "../components/ui/alert-dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { FaTelegram, FaDiscord, FaSlack, FaWhatsapp, FaLine } from "react-icons/fa6";

interface OwnMcpServer {
  name: string;
  config: Record<string, any>;
}

interface Tenant {
  id: string;
  plan: string;
  status: string;
  suspended?: boolean;
  suspendReason?: string;
  maxCostPerTask?: number;
  maxDailyCost?: number;
  model?: string;
  defaultModel?: string;
  allowedPaths?: string[];
  blockedPaths?: string[];
  tools?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  mcpServers?: string[];
  ownMcpServers?: Record<string, any>;
  modelRoutes?: Record<string, string>;
  notes?: string;
  taskCount?: number;
  totalCost?: number;
  lastSeenAt?: string;
  createdAt?: string;
}

const CHANNEL_CRED_MAP = [
  { channel: "telegram", label: "Telegram", icon: FaTelegram, color: "#29B6F6", keys: ["TELEGRAM_BOT_TOKEN"] },
  { channel: "discord",  label: "Discord",  icon: FaDiscord,  color: "#5865F2", keys: ["DISCORD_BOT_TOKEN"] },
  { channel: "slack",    label: "Slack",     icon: FaSlack,    color: "#E01E5A", keys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] },
  { channel: "whatsapp", label: "WhatsApp",  icon: FaWhatsapp, color: "#25D366", keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"] },
  { channel: "line",     label: "LINE",      icon: FaLine,     color: "#00B900", keys: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"] },
];

export function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [apiKeyNames, setApiKeyNames] = useState<string[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [showKeyValue, setShowKeyValue] = useState(false);
  const [keySaving, setKeySaving] = useState(false);

  // Available options for dropdowns (fetched once)
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<string[]>([]);

  // Channel credentials state
  const [channelCredKeys, setChannelCredKeys] = useState<string[]>([]);
  const [newCredValues, setNewCredValues] = useState<Record<string, string>>({});
  const [showCredValue, setShowCredValue] = useState(false);
  const [credSaving, setCredSaving] = useState(false);

  // Own MCP servers state
  const [ownMcpServers, setOwnMcpServers] = useState<OwnMcpServer[]>([]);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpConfig, setNewMcpConfig] = useState('{\n  "command": "npx",\n  "args": ["-y", "@scope/server-name"],\n  "env": {}\n}');
  const [mcpSaving, setMcpSaving] = useState(false);

  // Create tenant dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", plan: "free", notes: "" });
  const [creating, setCreating] = useState(false);

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; description?: string; onConfirm: () => void }>({ open: false, title: "", onConfirm: () => {} });

  const fetchTenants = async () => {
    try {
      const res = await apiFetch("/api/tenants");
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
    // Fetch available tools, models, MCP servers for dropdowns
    apiFetch("/api/tools").then(r => r.json()).then(d => setAvailableTools(d.tools || [])).catch(() => {});
    apiFetch("/api/models").then(r => r.json()).then(d => setAvailableModels((d.available || []).map((m: any) => m.id))).catch(() => {});
    apiFetch("/api/mcp").then(r => r.json()).then(d => setAvailableMcpServers((d.servers || []).map((s: any) => s.name))).catch(() => {});
  }, []);

  const handleSuspend = async (id: string) => {
    const toastId = toast.loading("SUSPENDING TENANT...");
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(id)}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Suspended via UI" }),
      });
      if (res.ok) { toast.success("TENANT SUSPENDED", { id: toastId }); fetchTenants(); }
      else { const err = await res.json(); toast.error(err.error || "FAILED TO SUSPEND", { id: toastId }); }
    } catch (error: any) { toast.error(error.message, { id: toastId }); }
  };

  const handleUnsuspend = async (id: string) => {
    const toastId = toast.loading("UNSUSPENDING TENANT...");
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(id)}/unsuspend`, { method: "POST" });
      if (res.ok) { toast.success("TENANT UNSUSPENDED", { id: toastId }); fetchTenants(); }
      else { const err = await res.json(); toast.error(err.error || "FAILED TO UNSUSPEND", { id: toastId }); }
    } catch (error: any) { toast.error(error.message, { id: toastId }); }
  };

  const handleDelete = (id: string) => {
    setConfirmState({
      open: true,
      title: `Delete tenant "${id}"?`,
      description: "This cannot be undone.",
      onConfirm: async () => {
        const toastId = toast.loading("DELETING TENANT...");
        try {
          const res = await apiFetch(`/api/tenants/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (res.ok) { toast.success("Tenant deleted", { id: toastId }); fetchTenants(); }
          else { const err = await res.json(); toast.error(err.error || "FAILED TO DELETE", { id: toastId }); }
        } catch (error: any) { toast.error(error.message, { id: toastId }); }
      },
    });
  };

  const fetchChannelCredKeys = async (tenantId: string) => {
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(tenantId)}/channel-config`);
      if (res.ok) { const data = await res.json(); setChannelCredKeys(data.keys || []); }
    } catch { setChannelCredKeys([]); }
  };

  const handleConnectService = async (serviceName: string, keys: string[]) => {
    if (!editTenant) return;
    setKeySaving(true);
    const toastId = toast.loading(`Saving ${serviceName} keys...`);
    try {
      for (const key of keys) {
        const value = (newCredValues[key] || "").trim();
        if (!value) continue;
        const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/apikeys/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
        if (!res.ok) { const err = await res.json(); toast.error(err.error || `Failed to save ${key}`, { id: toastId }); return; }
      }
      toast.success(`${serviceName} configured`, { id: toastId });
      setNewCredValues(v => { const next = { ...v }; keys.forEach(k => delete next[k]); return next; });
      fetchApiKeys(editTenant.id);
    } catch (e: any) { toast.error(e.message, { id: toastId }); }
    finally { setKeySaving(false); }
  };

  const handleConnectChannel = async (channel: string, keys: string[]) => {
    if (!editTenant) return;
    setCredSaving(true);
    const toastId = toast.loading(`Connecting ${channel}...`);
    try {
      for (const key of keys) {
        const value = (newCredValues[key] || "").trim();
        if (!value) continue;
        const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channel-config/${encodeURIComponent(key)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
        if (!res.ok) { const err = await res.json(); toast.error(err.error || `Failed to save ${key}`, { id: toastId }); return; }
      }
      toast.success(`${channel} connected — bot starting...`, { id: toastId });
      setNewCredValues(v => { const next = { ...v }; keys.forEach(k => delete next[k]); return next; });
      fetchChannelCredKeys(editTenant.id);
    } catch (e: any) { toast.error(e.message, { id: toastId }); }
    finally { setCredSaving(false); }
  };

  const handleDeleteChannelCred = (key: string) => {
    if (!editTenant) return;
    setConfirmState({
      open: true,
      title: `Remove credential "${key}"?`,
      description: "The channel will disconnect.",
      onConfirm: async () => {
        try {
          const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channel-config/${encodeURIComponent(key)}`, { method: "DELETE" });
          if (res.ok) { toast.success(`${key} removed`); fetchChannelCredKeys(editTenant.id); }
          else { const err = await res.json(); toast.error(err.error || "Failed to remove"); }
        } catch (e: any) { toast.error(e.message); }
      },
    });
  };

  const fetchApiKeys = async (tenantId: string) => {
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(tenantId)}/apikeys`);
      if (res.ok) { const data = await res.json(); setApiKeyNames(data.keys || []); }
    } catch { setApiKeyNames([]); }
  };

  const fetchOwnMcpServers = async (tenantId: string) => {
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(tenantId)}/mcp-servers`);
      if (res.ok) {
        const data = await res.json();
        const servers = Object.entries(data.mcpServers || {}).map(([name, config]) => ({ name, config: config as Record<string, any> }));
        setOwnMcpServers(servers);
      }
    } catch { setOwnMcpServers([]); }
  };

  const handleAddOwnMcpServer = async () => {
    if (!editTenant || !newMcpName.trim()) { toast.error("Server name is required"); return; }
    let serverConfig: Record<string, any>;
    try { serverConfig = JSON.parse(newMcpConfig); } catch { toast.error("Invalid JSON in server config"); return; }
    if (!serverConfig.command && !serverConfig.url) { toast.error("Server config must have 'command' (stdio) or 'url' (http/sse)"); return; }
    setMcpSaving(true);
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/mcp-servers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newMcpName.trim(), serverConfig }),
      });
      if (res.ok) {
        toast.success(`MCP server "${newMcpName.trim()}" added`);
        setNewMcpName("");
        setNewMcpConfig('{\n  "command": "npx",\n  "args": ["-y", "@scope/server-name"],\n  "env": {}\n}');
        fetchOwnMcpServers(editTenant.id);
      } else { const err = await res.json(); toast.error(err.error || "Failed to add MCP server"); }
    } catch (e: any) { toast.error(e.message); }
    finally { setMcpSaving(false); }
  };

  const handleRemoveOwnMcpServer = (name: string) => {
    if (!editTenant) return;
    setConfirmState({
      open: true,
      title: `Remove MCP server "${name}"?`,
      onConfirm: async () => {
        try {
          const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/mcp-servers/${encodeURIComponent(name)}`, { method: "DELETE" });
          if (res.ok) { toast.success(`MCP server "${name}" removed`); fetchOwnMcpServers(editTenant.id); }
          else { const err = await res.json(); toast.error(err.error || "Failed to remove"); }
        } catch (e: any) { toast.error(e.message); }
      },
    });
  };

  const handleAddApiKey = async () => {
    if (!editTenant || !newKeyName.trim() || !newKeyValue.trim()) { toast.error("Key name and value are required"); return; }
    if (newKeyValue.length < 4) { toast.error("Key value must be at least 4 characters"); return; }
    setKeySaving(true);
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/apikeys/${encodeURIComponent(newKeyName.trim())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: newKeyValue }),
      });
      if (res.ok) {
        toast.success(`${newKeyName.trim()} saved`);
        setNewKeyName(""); setNewKeyValue(""); setShowKeyValue(false);
        fetchApiKeys(editTenant.id);
      } else { const err = await res.json(); toast.error(err.error || "Failed to save key"); }
    } catch (e: any) { toast.error(e.message); }
    finally { setKeySaving(false); }
  };

  const handleDeleteApiKey = async (keyName: string) => {
    if (!editTenant) return;
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/apikeys/${encodeURIComponent(keyName)}`, { method: "DELETE" });
      if (res.ok) { toast.success(`${keyName} deleted`); fetchApiKeys(editTenant.id); }
      else { toast.error("Failed to delete key"); }
    } catch (e: any) { toast.error(e.message); }
  };

  const handleCreateTenant = async () => {
    if (!createForm.name.trim()) { toast.error("Tenant name is required"); return; }
    setCreating(true);
    const toastId = toast.loading("CREATING TENANT...");
    try {
      const res = await apiFetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createForm.name.trim(), plan: createForm.plan, notes: createForm.notes }),
      });
      if (res.ok) {
        toast.success("TENANT CREATED", { id: toastId });
        setShowCreate(false);
        setCreateForm({ name: "", plan: "free", notes: "" });
        fetchTenants();
      } else { const err = await res.json(); toast.error(err.error || "FAILED TO CREATE", { id: toastId }); }
    } catch (e: any) { toast.error(e.message, { id: toastId }); }
    finally { setCreating(false); }
  };

  const openEdit = (tenant: Tenant) => {
    setEditTenant(tenant);
    setEditForm({
      defaultModel: (tenant as any).model || tenant.defaultModel || "",
      plan: tenant.plan || "free",
      maxCostPerTask: tenant.maxCostPerTask ?? "",
      maxDailyCost: tenant.maxDailyCost ?? "",
      allowedPaths: (tenant.allowedPaths || []).join(", "),
      blockedPaths: (tenant.blockedPaths || []).join(", "),
      allowedTools: ((tenant as any).tools || tenant.allowedTools || []).join(", "),
      blockedTools: (tenant.blockedTools || []).join(", "),
      mcpServers: (tenant.mcpServers || []).join(", "),
      modelRoutes: JSON.stringify(tenant.modelRoutes || {}, null, 2),
      notes: tenant.notes || "",
    });
    setNewKeyName(""); setNewKeyValue(""); setShowKeyValue(false);
    setNewCredValues({}); setShowCredValue(false);
    setNewMcpName(""); setNewMcpConfig('{\n  "command": "npx",\n  "args": ["-y", "@scope/server-name"],\n  "env": {}\n}');
    fetchApiKeys(tenant.id);
    fetchChannelCredKeys(tenant.id);
    fetchOwnMcpServers(tenant.id);
  };

  const handleSaveEdit = async () => {
    if (!editTenant) return;
    const toastId = toast.loading("UPDATING TENANT...");
    const splitList = (s: string) => s ? s.split(",").map((v: string) => v.trim()).filter(Boolean) : [];
    const validatePaths = (paths: string[], label: string): string | null => {
      for (const p of paths) {
        if (!p.startsWith("/") && !/^[A-Za-z]:[\\\/]/.test(p)) return `${label}: "${p}" must be an absolute path`;
        if (/\.\.[\\/]/.test(p)) return `${label}: "${p}" must not contain ".." traversal`;
      }
      return null;
    };
    try {
      let modelRoutes = {};
      try { modelRoutes = JSON.parse(editForm.modelRoutes || "{}"); } catch { }
      const allowedPaths = splitList(editForm.allowedPaths);
      const blockedPaths = splitList(editForm.blockedPaths);
      const pathErr = validatePaths(allowedPaths, "Allowed Paths") || validatePaths(blockedPaths, "Blocked Paths");
      if (pathErr) { toast.error(pathErr, { id: toastId }); return; }

      const body: Record<string, any> = {
        model: editForm.defaultModel || null,
        plan: editForm.plan,
        notes: editForm.notes || undefined,
        allowedPaths,
        blockedPaths,
        tools: splitList(editForm.allowedTools),
        blockedTools: splitList(editForm.blockedTools),
        mcpServers: splitList(editForm.mcpServers),
        modelRoutes,
      };
      if (editForm.maxCostPerTask !== "") body.maxCostPerTask = parseFloat(editForm.maxCostPerTask);
      if (editForm.maxDailyCost !== "") body.maxDailyCost = parseFloat(editForm.maxDailyCost);

      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) { toast.success("TENANT UPDATED", { id: toastId }); setEditTenant(null); fetchTenants(); }
      else { const err = await res.json(); toast.error(err.error || "FAILED TO UPDATE", { id: toastId }); }
    } catch (error: any) { toast.error(error.message, { id: toastId }); }
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Tenants</h2>
          <p className="text-gray-400 font-mono text-sm tracking-widest">USER & CHANNEL MANAGEMENT</p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          className="bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/25 font-mono text-[10px] uppercase"
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Create Tenant
        </Button>
      </div>

      {/* Tenant Cards */}
      <div className="grid grid-cols-1 gap-4">
        {tenants.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-slate-800 rounded-xl bg-slate-900/20">
            <Users className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">NO TENANTS REGISTERED</p>
            <p className="text-gray-700 font-mono text-[10px] mt-2">Tenants are created when users message via any connected channel</p>
          </div>
        ) : (
          tenants.map((tenant) => (
            <Card
              key={tenant.id}
              className={`bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl transition-all border-l-4 ${
                tenant.suspended ? "border-l-amber-500" : "border-l-[#00ff88]"
              }`}
            >
              <CardHeader className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${
                      tenant.suspended
                        ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                        : "bg-[#00ff88] shadow-[0_0_8px_rgba(0,255,136,0.5)]"
                    }`} />
                    <div>
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-white font-mono text-lg uppercase tracking-tight">{tenant.id}</CardTitle>
                        <Badge variant="outline" className={`font-mono text-[9px] uppercase ${planColor(tenant.plan)}`}>
                          {tenant.plan}
                        </Badge>
                        {tenant.suspended && (
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
                    <Button variant="ghost" size="sm" onClick={() => openEdit(tenant)}
                      className="text-[#00d9ff] hover:bg-[#00d9ff]/10 font-mono text-[10px] uppercase">
                      <Pencil className="w-3 h-3 mr-1" />Edit
                    </Button>
                    {tenant.suspended ? (
                      <Button variant="ghost" size="sm" onClick={() => handleUnsuspend(tenant.id)}
                        className="text-[#00ff88] hover:bg-[#00ff88]/10 font-mono text-[10px] uppercase">
                        <Play className="w-3 h-3 mr-1" />Unsuspend
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => handleSuspend(tenant.id)}
                        className="text-amber-500 hover:bg-amber-500/10 font-mono text-[10px] uppercase">
                        <Pause className="w-3 h-3 mr-1" />Suspend
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(tenant.id)}
                      className="text-red-500/70 hover:text-red-500 font-mono text-[10px] uppercase hover:bg-red-500/10">
                      <Trash2 className="w-3 h-3 mr-1" />Delete
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {(tenant.model || tenant.notes || (tenant.mcpServers && tenant.mcpServers.length > 0)) && (
                <CardContent className="pb-4 pt-0">
                  <div className="flex flex-wrap gap-3 text-[10px] font-mono text-gray-500">
                    {tenant.model && <span>Model: <span className="text-gray-300">{tenant.model}</span></span>}
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

      {/* Create Tenant Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => !open && setShowCreate(false)}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white border-2 shadow-[0_0_30px_rgba(0,217,255,0.1)] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white uppercase font-bold tracking-widest border-b border-slate-800 pb-4">
              Create Tenant
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4 font-mono">
            <p className="text-[10px] text-gray-500">Create a tenant, then add channel bot tokens in the edit dialog to spin up dedicated channel instances.</p>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Tenant Name</label>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                placeholder="e.g. acme-corp, john-doe"
                className="bg-slate-900 border-slate-800 text-white text-xs font-mono"
              />
              <p className="text-[9px] text-gray-600">Unique identifier — lowercase, hyphens allowed</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Plan</label>
                <Select value={createForm.plan} onValueChange={(v) => setCreateForm({ ...createForm, plan: v })}>
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
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Notes</label>
                <Input
                  value={createForm.notes}
                  onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                  placeholder="Optional notes..."
                  className="bg-slate-900 border-slate-800 text-white text-xs"
                />
              </div>
            </div>
            <Button
              onClick={handleCreateTenant}
              disabled={creating || !createForm.name.trim()}
              className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white mt-2 uppercase tracking-tighter"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
              Create Tenant
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
                <Select value={editForm.defaultModel || "global"} onValueChange={(v) => setEditForm({ ...editForm, defaultModel: v === "global" ? "" : v })}>
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-xs">
                    <SelectValue placeholder="Use global default" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800 text-white max-h-48">
                    <SelectItem value="global" className="text-xs text-gray-500">Use global default</SelectItem>
                    {availableModels.map(m => (
                      <SelectItem key={m} value={m} className="text-[10px] font-mono">{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Plan</label>
                <Select value={editForm.plan || "free"} onValueChange={(value) => setEditForm({ ...editForm, plan: value })}>
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
                <Input type="number" step="0.01" value={editForm.maxCostPerTask ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, maxCostPerTask: e.target.value })}
                  placeholder="e.g. 0.50" className="bg-slate-900 border-slate-800 text-white text-xs" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] text-gray-500 uppercase">Max Daily Cost</label>
                <Input type="number" step="0.01" value={editForm.maxDailyCost ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, maxDailyCost: e.target.value })}
                  placeholder="e.g. 5.00" className="bg-slate-900 border-slate-800 text-white text-xs" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Allowed Paths (comma-separated)</label>
              <Input value={editForm.allowedPaths || ""} onChange={(e) => setEditForm({ ...editForm, allowedPaths: e.target.value })}
                placeholder="/home/user, /tmp" className="bg-slate-900 border-slate-800 text-white text-xs" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Blocked Paths (comma-separated)</label>
              <Input value={editForm.blockedPaths || ""} onChange={(e) => setEditForm({ ...editForm, blockedPaths: e.target.value })}
                placeholder="/etc, /root" className="bg-slate-900 border-slate-800 text-white text-xs" />
            </div>
            {/* Allowed Tools */}
            <div className="space-y-1.5">
              <label className="text-[10px] text-gray-500 uppercase">Allowed Tools</label>
              <Select value="" onValueChange={(v) => {
                const current = (editForm.allowedTools || "").split(",").map((t: string) => t.trim()).filter(Boolean);
                if (!current.includes(v)) setEditForm({ ...editForm, allowedTools: [...current, v].join(", ") });
              }}>
                <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono">
                  <SelectValue placeholder="Add tool..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-800 text-white max-h-48">
                  {availableTools.filter(t => !(editForm.allowedTools || "").split(",").map((x: string) => x.trim()).includes(t)).map(t => (
                    <SelectItem key={t} value={t} className="text-[10px] font-mono">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(editForm.allowedTools || "").split(",").some((t: string) => t.trim()) && (
                <div className="flex flex-wrap gap-1">
                  {(editForm.allowedTools || "").split(",").filter((t: string) => t.trim()).map((t: string) => (
                    <span key={t.trim()} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#00d9ff]/10 border border-[#00d9ff]/30 text-[9px] font-mono text-[#00d9ff]">
                      {t.trim()}
                      <button onClick={() => setEditForm({ ...editForm, allowedTools: (editForm.allowedTools || "").split(",").filter((x: string) => x.trim() !== t.trim()).join(", ") })} className="hover:text-red-400"><X className="w-2.5 h-2.5" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Blocked Tools */}
            <div className="space-y-1.5">
              <label className="text-[10px] text-gray-500 uppercase">Blocked Tools</label>
              <Select value="" onValueChange={(v) => {
                const current = (editForm.blockedTools || "").split(",").map((t: string) => t.trim()).filter(Boolean);
                if (!current.includes(v)) setEditForm({ ...editForm, blockedTools: [...current, v].join(", ") });
              }}>
                <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono">
                  <SelectValue placeholder="Block tool..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-800 text-white max-h-48">
                  {availableTools.filter(t => !(editForm.blockedTools || "").split(",").map((x: string) => x.trim()).includes(t)).map(t => (
                    <SelectItem key={t} value={t} className="text-[10px] font-mono">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(editForm.blockedTools || "").split(",").some((t: string) => t.trim()) && (
                <div className="flex flex-wrap gap-1">
                  {(editForm.blockedTools || "").split(",").filter((t: string) => t.trim()).map((t: string) => (
                    <span key={t.trim()} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-[9px] font-mono text-red-400">
                      {t.trim()}
                      <button onClick={() => setEditForm({ ...editForm, blockedTools: (editForm.blockedTools || "").split(",").filter((x: string) => x.trim() !== t.trim()).join(", ") })} className="hover:text-red-300"><X className="w-2.5 h-2.5" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* MCP Servers */}
            <div className="space-y-1.5">
              <label className="text-[10px] text-gray-500 uppercase">MCP Servers (Allowlist)</label>
              <Select value="" onValueChange={(v) => {
                const current = (editForm.mcpServers || "").split(",").map((t: string) => t.trim()).filter(Boolean);
                if (!current.includes(v)) setEditForm({ ...editForm, mcpServers: [...current, v].join(", ") });
              }}>
                <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono">
                  <SelectValue placeholder="Add MCP server..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-800 text-white max-h-48">
                  {availableMcpServers.filter(s => !(editForm.mcpServers || "").split(",").map((x: string) => x.trim()).includes(s)).map(s => (
                    <SelectItem key={s} value={s} className="text-[10px] font-mono">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(editForm.mcpServers || "").split(",").some((t: string) => t.trim()) && (
                <div className="flex flex-wrap gap-1">
                  {(editForm.mcpServers || "").split(",").filter((t: string) => t.trim()).map((t: string) => (
                    <span key={t.trim()} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#4ECDC4]/10 border border-[#4ECDC4]/30 text-[9px] font-mono text-[#4ECDC4]">
                      {t.trim()}
                      <button onClick={() => setEditForm({ ...editForm, mcpServers: (editForm.mcpServers || "").split(",").filter((x: string) => x.trim() !== t.trim()).join(", ") })} className="hover:text-red-400"><X className="w-2.5 h-2.5" /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Model Routes */}
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Model Routes</label>
              <p className="text-[9px] text-gray-600">Assign specific models to agent profiles. Add custom profiles as needed.</p>
              {(() => {
                const routes: Record<string, string> = (() => { try { return JSON.parse(editForm.modelRoutes || "{}"); } catch { return {}; } })();
                const profiles = Object.keys(routes);
                return (
                  <>
                    {profiles.length > 0 && (
                      <div className="space-y-1.5">
                        {profiles.map(profile => (
                          <div key={profile} className="flex items-center gap-2">
                            <span className="text-[9px] font-mono text-gray-400 w-20 uppercase shrink-0 truncate">{profile}</span>
                            <Select value={routes[profile] || ""} onValueChange={(v) => {
                              const updated = { ...routes };
                              if (!v || v === "default") delete updated[profile];
                              else updated[profile] = v;
                              setEditForm({ ...editForm, modelRoutes: JSON.stringify(updated) });
                            }}>
                              <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-[10px] h-7 font-mono flex-1">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-950 border-slate-800 text-white max-h-48">
                                <SelectItem value="default" className="text-[10px] font-mono text-gray-500">Default</SelectItem>
                                {availableModels.map(m => (
                                  <SelectItem key={m} value={m} className="text-[10px] font-mono">{m}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <button onClick={() => {
                              const updated = { ...routes };
                              delete updated[profile];
                              setEditForm({ ...editForm, modelRoutes: JSON.stringify(updated) });
                            }} className="text-red-500/50 hover:text-red-500"><X className="w-3 h-3" /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Profile name..."
                        className="bg-slate-900 border-slate-800 text-white text-[10px] h-7 font-mono flex-1"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const name = (e.target as HTMLInputElement).value.trim().toLowerCase().replace(/\s+/g, "-");
                            if (name && !routes[name]) {
                              setEditForm({ ...editForm, modelRoutes: JSON.stringify({ ...routes, [name]: "" }) });
                              (e.target as HTMLInputElement).value = "";
                            }
                          }
                        }}
                      />
                      <span className="text-[8px] text-gray-600 shrink-0">Enter to add</span>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* API Keys — per-service cards */}
            <div className="space-y-3 p-4 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-[#ffaa00]" />
                <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">API Keys (Encrypted)</label>
              </div>
              <p className="text-[9px] text-gray-600">Per-tenant keys override global defaults. Only configure what this tenant needs.</p>

              {[
                { service: "LLM Providers", keys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY"], color: "#00d9ff" },
                { service: "ElevenLabs TTS", keys: ["ELEVENLABS_API_KEY"], color: "#f0883e" },
                { service: "Email (Resend)", keys: ["RESEND_API_KEY", "RESEND_FROM"], color: "#a78bfa" },
                { service: "Email (SMTP)", keys: ["EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_SMTP_HOST"], color: "#a78bfa" },
                { service: "Brave Search", keys: ["BRAVE_API_KEY"], color: "#f97316" },
                { service: "Google Places", keys: ["GOOGLE_PLACES_API_KEY"], color: "#4ade80" },
                { service: "Pushover", keys: ["PUSHOVER_API_TOKEN", "PUSHOVER_USER_KEY"], color: "#38bdf8" },
                { service: "Ntfy", keys: ["NTFY_TOPIC", "NTFY_TOKEN"], color: "#38bdf8" },
                { service: "Database", keys: ["DATABASE_URL", "POSTGRES_URL"], color: "#fbbf24" },
                { service: "Google Contacts", keys: ["GOOGLE_CONTACTS_ACCESS_TOKEN"], color: "#34d399" },
                { service: "Google Calendar", keys: ["GOOGLE_CALENDAR_ACCESS_TOKEN"], color: "#34d399" },
              ].map(({ service, keys, color }) => {
                const connected = keys.every(k => apiKeyNames.includes(k));
                const partial = keys.some(k => apiKeyNames.includes(k));
                return (
                  <div key={service} className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono font-medium" style={{ color }}>{service}</span>
                      {connected ? (
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-[#00ff88]/10 border-[#00ff88]/30 text-[#00ff88] text-[8px] font-mono">CONFIGURED</Badge>
                          <button onClick={() => keys.forEach(k => handleDeleteApiKey(k))} className="text-red-500/50 hover:text-red-500"><X className="w-3 h-3" /></button>
                        </div>
                      ) : partial ? (
                        <Badge variant="outline" className="bg-[#ffaa00]/10 border-[#ffaa00]/30 text-[#ffaa00] text-[8px] font-mono">INCOMPLETE</Badge>
                      ) : null}
                    </div>
                    {!connected && (
                      <div className="space-y-1.5 pt-1">
                        {keys.filter(k => !apiKeyNames.includes(k)).map(k => (
                          <Input
                            key={k}
                            type="password"
                            value={newCredValues[k] || ""}
                            onChange={(e) => setNewCredValues(v => ({ ...v, [k]: e.target.value }))}
                            placeholder={k}
                            className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono"
                          />
                        ))}
                        <Button
                          onClick={() => handleConnectService(service, keys.filter(k => !apiKeyNames.includes(k)))}
                          disabled={keySaving || keys.filter(k => !apiKeyNames.includes(k)).some(k => !(newCredValues[k] || "").trim())}
                          size="sm"
                          className="h-8 text-[10px] font-mono uppercase w-full"
                          style={{ backgroundColor: `${color}15`, color, borderColor: `${color}30` }}
                        >
                          {keySaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                          Save {service}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Channel Connections */}
            <div className="space-y-3 p-4 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-[#00d9ff]" />
                <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Channel Connections</label>
              </div>
              <p className="text-[9px] text-gray-600">
                Select channels to enable for this tenant. Tokens are encrypted (AES-256-GCM) and start a dedicated bot instance immediately.
              </p>

              {/* Per-channel sections */}
              {CHANNEL_CRED_MAP.map(({ channel, label, icon: Icon, color, keys }) => {
                const connected = keys.every(k => channelCredKeys.includes(k));
                const partial = keys.some(k => channelCredKeys.includes(k));
                return (
                  <div key={channel} className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="w-5 h-5" style={{ color }} />
                        <span className="text-sm font-medium text-white">{label}</span>
                      </div>
                      {connected ? (
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="bg-[#00ff88]/10 border-[#00ff88]/30 text-[#00ff88] text-[8px] font-mono">CONNECTED</Badge>
                          <button
                            onClick={() => keys.forEach(k => handleDeleteChannelCred(k))}
                            className="text-red-500/50 hover:text-red-500 transition-colors"
                            title="Disconnect"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : partial ? (
                        <Badge variant="outline" className="bg-[#ffaa00]/10 border-[#ffaa00]/30 text-[#ffaa00] text-[8px] font-mono">INCOMPLETE</Badge>
                      ) : null}
                    </div>
                    {!connected && (
                      <div className="space-y-1.5 pt-1">
                        {keys.map(k => (
                          <div key={k} className="relative">
                            <Input
                              type={showCredValue ? "text" : "password"}
                              value={newCredValues[k] || ""}
                              onChange={(e) => setNewCredValues(v => ({ ...v, [k]: e.target.value }))}
                              placeholder={k}
                              className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono pr-8"
                            />
                          </div>
                        ))}
                        <Button
                          onClick={() => handleConnectChannel(channel, keys)}
                          disabled={credSaving || keys.some(k => !(newCredValues[k] || "").trim())}
                          size="sm"
                          className="bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/25 h-8 text-[10px] font-mono uppercase w-full"
                        >
                          {credSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                          Connect {channel}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Own MCP Servers */}
            <div className="space-y-3 p-4 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-[#4ECDC4]" />
                <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Private MCP Servers</label>
              </div>
              <p className="text-[9px] text-gray-600">MCP servers only this tenant can use. Global MCP allowlist above controls access to system-wide servers.</p>

              {ownMcpServers.length > 0 ? (
                <div className="space-y-1.5">
                  {ownMcpServers.map((s) => {
                    const transport = s.config.command ? "stdio" : s.config.transport === "sse" ? "sse" : "http";
                    const endpoint = s.config.command ? `${s.config.command} ${(s.config.args || []).join(" ")}`.trim() : s.config.url || "";
                    return (
                      <div key={s.name} className="flex items-center justify-between px-3 py-2 bg-slate-900/50 border border-slate-800 rounded-lg">
                        <div>
                          <span className="text-[10px] font-mono text-[#4ECDC4]">{s.name}</span>
                          <span className="text-[9px] font-mono text-gray-600 ml-2">({transport}) {endpoint.slice(0, 40)}{endpoint.length > 40 ? "…" : ""}</span>
                        </div>
                        <button onClick={() => handleRemoveOwnMcpServer(s.name)} className="text-red-500/50 hover:text-red-500 transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[10px] text-gray-600 font-mono italic">No private MCP servers — using global servers only</p>
              )}

              <div className="space-y-2 pt-1">
                <Input
                  value={newMcpName}
                  onChange={(e) => setNewMcpName(e.target.value)}
                  placeholder="Server name (e.g. my-postgres, notion)"
                  className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono"
                />
                <Textarea
                  value={newMcpConfig}
                  onChange={(e) => setNewMcpConfig(e.target.value)}
                  className="bg-slate-900 border-slate-800 text-white text-[10px] font-mono min-h-[80px]"
                  placeholder='{ "command": "npx", "args": [...] } or { "url": "https://..." }'
                />
                <Button
                  onClick={handleAddOwnMcpServer}
                  disabled={mcpSaving || !newMcpName.trim()}
                  size="sm"
                  className="bg-[#4ECDC4]/15 text-[#4ECDC4] border border-[#4ECDC4]/30 hover:bg-[#4ECDC4]/25 h-8 text-[10px] font-mono uppercase"
                >
                  {mcpSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                  Add Server
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Notes</label>
              <Input value={editForm.notes || ""} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                placeholder="Internal notes..." className="bg-slate-900 border-slate-800 text-white text-xs" />
            </div>

            <Button onClick={handleSaveEdit}
              className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] hover:opacity-90 text-white mt-4 uppercase tracking-tighter">
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmState.open} onOpenChange={(open) => setConfirmState((s) => ({ ...s, open }))}>
        <AlertDialogContent className="bg-slate-900 border border-slate-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white font-mono uppercase text-sm tracking-wide">{confirmState.title}</AlertDialogTitle>
            {confirmState.description && (
              <AlertDialogDescription className="text-gray-400 font-mono text-xs">{confirmState.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-800 border-slate-700 text-gray-300 hover:bg-slate-700 font-mono text-xs uppercase">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 font-mono text-xs uppercase"
              onClick={() => { confirmState.onConfirm(); setConfirmState((s) => ({ ...s, open: false })); }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
