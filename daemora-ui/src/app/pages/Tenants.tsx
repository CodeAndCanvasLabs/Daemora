import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Users, Loader2, Trash2, Pause, Play, Pencil, RotateCcw, Key, Plus, X, Eye, EyeOff, Link, Unlink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";

interface ChannelIdentity {
  channel: string;
  user_id: string;
  linked_at: string;
}

interface OwnMcpServer {
  name: string;
  config: Record<string, any>;
}

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
  ownMcpServers?: Record<string, any>;
  modelRoutes?: Record<string, string>;
  notes?: string;
  taskCount?: number;
  totalCost?: number;
  lastSeen?: string;
  createdAt?: string;
  channels?: ChannelIdentity[];
}

const CHANNEL_ICONS: Record<string, string> = {
  discord: "🟣",
  telegram: "🔵",
  slack: "🟡",
  whatsapp: "🟢",
  email: "📧",
  http: "🌐",
};

const CHANNEL_OPTIONS = ["discord", "telegram", "slack", "whatsapp", "email", "signal", "matrix", "irc", "line"];

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

  // Channel linking state
  const [linkChannel, setLinkChannel] = useState("");
  const [linkUserId, setLinkUserId] = useState("");
  const [linkSaving, setLinkSaving] = useState(false);

  // Channel credentials state
  const [channelCredKeys, setChannelCredKeys] = useState<string[]>([]);
  const [newCredKey, setNewCredKey] = useState("");
  const [newCredValue, setNewCredValue] = useState("");
  const [showCredValue, setShowCredValue] = useState(false);
  const [credSaving, setCredSaving] = useState(false);

  // Own MCP servers state
  const [ownMcpServers, setOwnMcpServers] = useState<OwnMcpServer[]>([]);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpConfig, setNewMcpConfig] = useState('{\n  "command": "npx",\n  "args": ["-y", "@scope/server-name"],\n  "env": {}\n}');
  const [mcpSaving, setMcpSaving] = useState(false);

  // Create tenant dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ channel: "", userId: "", plan: "free", notes: "" });
  const [creating, setCreating] = useState(false);

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

  useEffect(() => { fetchTenants(); }, []);

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

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete tenant "${id}"? This cannot be undone.`)) return;
    const toastId = toast.loading("DELETING TENANT...");
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) { toast.success("Tenant deleted", { id: toastId }); fetchTenants(); }
      else { const err = await res.json(); toast.error(err.error || "FAILED TO DELETE", { id: toastId }); }
    } catch (error: any) { toast.error(error.message, { id: toastId }); }
  };

  const fetchChannelCredKeys = async (tenantId: string) => {
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(tenantId)}/channel-config`);
      if (res.ok) { const data = await res.json(); setChannelCredKeys(data.keys || []); }
    } catch { setChannelCredKeys([]); }
  };

  const handleAddChannelCred = async () => {
    if (!editTenant || !newCredKey.trim() || !newCredValue.trim()) { toast.error("Key and value are required"); return; }
    setCredSaving(true);
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channel-config/${encodeURIComponent(newCredKey.trim())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: newCredValue }),
      });
      if (res.ok) {
        toast.success(`${newCredKey.trim()} saved — channel starting...`);
        setNewCredKey(""); setNewCredValue(""); setShowCredValue(false);
        fetchChannelCredKeys(editTenant.id);
      } else { const err = await res.json(); toast.error(err.error || "Failed to save credential"); }
    } catch (e: any) { toast.error(e.message); }
    finally { setCredSaving(false); }
  };

  const handleDeleteChannelCred = async (key: string) => {
    if (!editTenant || !confirm(`Remove credential "${key}"? The channel will disconnect.`)) return;
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channel-config/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (res.ok) { toast.success(`${key} removed`); fetchChannelCredKeys(editTenant.id); }
      else { const err = await res.json(); toast.error(err.error || "Failed to remove"); }
    } catch (e: any) { toast.error(e.message); }
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

  const handleRemoveOwnMcpServer = async (name: string) => {
    if (!editTenant || !confirm(`Remove MCP server "${name}"?`)) return;
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/mcp-servers/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) { toast.success(`MCP server "${name}" removed`); fetchOwnMcpServers(editTenant.id); }
      else { const err = await res.json(); toast.error(err.error || "Failed to remove"); }
    } catch (e: any) { toast.error(e.message); }
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

  const handleLinkChannel = async () => {
    if (!editTenant || !linkChannel || !linkUserId.trim()) { toast.error("Channel and user ID are required"); return; }
    setLinkSaving(true);
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: linkChannel, userId: linkUserId.trim() }),
      });
      if (res.ok) {
        toast.success(`${linkChannel}:${linkUserId.trim()} linked`);
        setLinkChannel(""); setLinkUserId("");
        // Refresh edit tenant channels
        const updated = tenants.find(t => t.id === editTenant.id);
        if (updated) {
          const channelsRes = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channels`);
          if (channelsRes.ok) {
            const channelsData = await channelsRes.json();
            setEditTenant({ ...editTenant, channels: channelsData.channels });
          }
        }
        fetchTenants();
      } else { const err = await res.json(); toast.error(err.error || "Failed to link channel"); }
    } catch (e: any) { toast.error(e.message); }
    finally { setLinkSaving(false); }
  };

  const handleUnlinkChannel = async (channel: string, userId: string) => {
    if (!editTenant) return;
    if (!confirm(`Unlink ${channel}:${userId}?`)) return;
    try {
      const res = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channels/${channel}/${encodeURIComponent(userId)}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(`${channel}:${userId} unlinked`);
        const channelsRes = await apiFetch(`/api/tenants/${encodeURIComponent(editTenant.id)}/channels`);
        if (channelsRes.ok) {
          const channelsData = await channelsRes.json();
          setEditTenant({ ...editTenant, channels: channelsData.channels });
        }
        fetchTenants();
      } else { const err = await res.json(); toast.error(err.error || "Failed to unlink"); }
    } catch (e: any) { toast.error(e.message); }
  };

  const handleCreateTenant = async () => {
    if (!createForm.channel || !createForm.userId.trim()) { toast.error("Channel and user ID are required"); return; }
    setCreating(true);
    const toastId = toast.loading("CREATING TENANT...");
    try {
      const res = await apiFetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: createForm.channel, userId: createForm.userId.trim(), plan: createForm.plan, notes: createForm.notes }),
      });
      if (res.ok) {
        toast.success("TENANT CREATED", { id: toastId });
        setShowCreate(false);
        setCreateForm({ channel: "", userId: "", plan: "free", notes: "" });
        fetchTenants();
      } else { const err = await res.json(); toast.error(err.error || "FAILED TO CREATE", { id: toastId }); }
    } catch (e: any) { toast.error(e.message, { id: toastId }); }
    finally { setCreating(false); }
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
    setNewKeyName(""); setNewKeyValue(""); setShowKeyValue(false);
    setLinkChannel(""); setLinkUserId("");
    setNewCredKey(""); setNewCredValue(""); setShowCredValue(false);
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
        defaultModel: editForm.defaultModel || undefined,
        plan: editForm.plan,
        notes: editForm.notes || undefined,
        allowedPaths,
        blockedPaths,
        allowedTools: splitList(editForm.allowedTools),
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
                      {/* Channel identities */}
                      {tenant.channels && tenant.channels.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          {tenant.channels.map((ch) => (
                            <span
                              key={`${ch.channel}:${ch.user_id}`}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 text-[9px] font-mono text-gray-300"
                            >
                              {CHANNEL_ICONS[ch.channel] || "💬"} {ch.channel}:{ch.user_id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(tenant)}
                      className="text-[#00d9ff] hover:bg-[#00d9ff]/10 font-mono text-[10px] uppercase">
                      <Pencil className="w-3 h-3 mr-1" />Edit
                    </Button>
                    {tenant.status === "suspended" ? (
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

      {/* Create Tenant Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => !open && setShowCreate(false)}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white border-2 shadow-[0_0_30px_rgba(0,217,255,0.1)] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white uppercase font-bold tracking-widest border-b border-slate-800 pb-4">
              Create Tenant
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4 font-mono">
            <p className="text-[10px] text-gray-500">Tenants are normally auto-created when a user messages. Use this to pre-configure a tenant before their first message.</p>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Channel</label>
              <Select value={createForm.channel} onValueChange={(v) => setCreateForm({ ...createForm, channel: v })}>
                <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-xs">
                  <SelectValue placeholder="Select channel..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-800 text-white">
                  {CHANNEL_OPTIONS.map(c => (
                    <SelectItem key={c} value={c} className="text-xs font-mono">{CHANNEL_ICONS[c] || "💬"} {c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">User ID</label>
              <Input
                value={createForm.userId}
                onChange={(e) => setCreateForm({ ...createForm, userId: e.target.value })}
                placeholder="e.g. 1026503197260513360"
                className="bg-slate-900 border-slate-800 text-white text-xs font-mono"
              />
              <p className="text-[9px] text-gray-600">The channel-specific user/chat ID</p>
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
              disabled={creating || !createForm.channel || !createForm.userId.trim()}
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

            {/* Channel Identities */}
            <div className="space-y-3 p-4 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-2">
                <Link className="w-3.5 h-3.5 text-[#00d9ff]" />
                <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Linked Channel Identities</label>
              </div>
              <p className="text-[9px] text-gray-600">Each identity is a channel+userId pair that maps to this tenant. Same person on Discord + Telegram = link both here.</p>

              {/* Existing identities */}
              {editTenant?.channels && editTenant.channels.length > 0 ? (
                <div className="space-y-1.5">
                  {editTenant.channels.map((ch) => (
                    <div key={`${ch.channel}:${ch.user_id}`} className="flex items-center justify-between px-3 py-2 bg-slate-900/50 border border-slate-800 rounded-lg">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{CHANNEL_ICONS[ch.channel] || "💬"}</span>
                        <div>
                          <span className="text-[10px] font-mono text-[#00d9ff]">{ch.channel}</span>
                          <span className="text-[10px] font-mono text-gray-400 ml-1">:{ch.user_id}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleUnlinkChannel(ch.channel, ch.user_id)}
                        className="text-red-500/50 hover:text-red-500 transition-colors"
                        title="Unlink"
                      >
                        <Unlink className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-gray-600 font-mono italic">No channel identities linked</p>
              )}

              {/* Link new identity */}
              <div className="flex gap-2 pt-1">
                <Select value={linkChannel} onValueChange={setLinkChannel}>
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-[10px] font-mono h-8 w-36 shrink-0">
                    <SelectValue placeholder="Channel..." />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800 text-white">
                    {CHANNEL_OPTIONS.map(c => (
                      <SelectItem key={c} value={c} className="text-[10px] font-mono">{CHANNEL_ICONS[c] || "💬"} {c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={linkUserId}
                  onChange={(e) => setLinkUserId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLinkChannel()}
                  placeholder="User / Chat ID"
                  className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono flex-1"
                />
                <Button
                  onClick={handleLinkChannel}
                  disabled={linkSaving || !linkChannel || !linkUserId.trim()}
                  size="sm"
                  className="bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/25 h-8 px-3 shrink-0"
                >
                  {linkSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>

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
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Allowed Tools (comma-separated)</label>
              <Input value={editForm.allowedTools || ""} onChange={(e) => setEditForm({ ...editForm, allowedTools: e.target.value })}
                placeholder="readFile, webSearch" className="bg-slate-900 border-slate-800 text-white text-xs" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Blocked Tools (comma-separated)</label>
              <Input value={editForm.blockedTools || ""} onChange={(e) => setEditForm({ ...editForm, blockedTools: e.target.value })}
                placeholder="shellExec, deleteFile" className="bg-slate-900 border-slate-800 text-white text-xs" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">MCP Servers (comma-separated)</label>
              <Input value={editForm.mcpServers || ""} onChange={(e) => setEditForm({ ...editForm, mcpServers: e.target.value })}
                placeholder="postgres-db, memory" className="bg-slate-900 border-slate-800 text-white text-xs" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] text-gray-500 uppercase">Model Routes (JSON)</label>
              <Textarea value={editForm.modelRoutes || "{}"} onChange={(e) => setEditForm({ ...editForm, modelRoutes: e.target.value })}
                placeholder='{"code": "gpt-4o", "research": "claude-3.5-sonnet"}'
                className="bg-slate-900 border-slate-800 text-white text-xs font-mono min-h-[60px]" />
            </div>

            {/* API Keys */}
            <div className="space-y-3 p-4 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-[#ffaa00]" />
                <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">API Keys (Encrypted)</label>
              </div>
              {apiKeyNames.length > 0 ? (
                <div className="space-y-1.5">
                  {apiKeyNames.map((name) => (
                    <div key={name} className="flex items-center justify-between px-3 py-1.5 bg-slate-900/50 border border-slate-800 rounded-lg">
                      <span className="text-[10px] font-mono text-[#00ff88]">{name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono text-gray-600">••••••••</span>
                        <button onClick={() => handleDeleteApiKey(name)} className="text-red-500/50 hover:text-red-500 transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-gray-600 font-mono italic">No API keys configured — uses global keys</p>
              )}
              <div className="space-y-2 pt-1">
                <Select value={newKeyName} onValueChange={setNewKeyName}>
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-white text-[10px] font-mono h-8">
                    <SelectValue placeholder="Select key to add..." />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800 text-white">
                    {["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY", "ELEVENLABS_API_KEY"].filter(k => !apiKeyNames.includes(k)).map((k) => (
                      <SelectItem key={k} value={k} className="text-[10px] font-mono">{k}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {newKeyName && (
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input type={showKeyValue ? "text" : "password"} value={newKeyValue}
                        onChange={(e) => setNewKeyValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAddApiKey()}
                        placeholder="sk-..." className="bg-slate-900 border-slate-800 text-white text-xs h-8 pr-8 font-mono" />
                      <button onClick={() => setShowKeyValue(!showKeyValue)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                        {showKeyValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <Button onClick={handleAddApiKey} disabled={keySaving || !newKeyValue} size="sm"
                      className="bg-[#ffaa00]/15 text-[#ffaa00] border border-[#ffaa00]/30 hover:bg-[#ffaa00]/25 h-8 px-3">
                      {keySaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Channel Credentials */}
            <div className="space-y-3 p-4 bg-slate-800/30 border border-slate-800 rounded-xl">
              <div className="flex items-center gap-2">
                <Key className="w-3.5 h-3.5 text-[#00d9ff]" />
                <label className="text-[10px] text-gray-400 uppercase tracking-wider font-bold">Channel Credentials</label>
              </div>
              <p className="text-[9px] text-gray-600">
                Bot tokens stored here are encrypted (AES-256-GCM) and start a dedicated channel instance for this tenant immediately.
                <br />
                <span className="text-gray-500">Keys: <code>TELEGRAM_BOT_TOKEN</code>, <code>DISCORD_BOT_TOKEN</code>, <code>SLACK_BOT_TOKEN</code>, <code>SLACK_APP_TOKEN</code>, <code>LINE_CHANNEL_ACCESS_TOKEN</code>, <code>LINE_CHANNEL_SECRET</code>, <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code></span>
              </p>

              {channelCredKeys.length > 0 ? (
                <div className="space-y-1.5">
                  {channelCredKeys.map((key) => (
                    <div key={key} className="flex items-center justify-between px-3 py-2 bg-slate-900/50 border border-slate-800 rounded-lg">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-[#00d9ff]">{key}</span>
                        <span className="text-[9px] font-mono text-gray-600">••••••••</span>
                      </div>
                      <button onClick={() => handleDeleteChannelCred(key)} className="text-red-500/50 hover:text-red-500 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-gray-600 font-mono italic">No channel credentials — tenant uses global bots</p>
              )}

              <div className="space-y-2 pt-1">
                <Input
                  value={newCredKey}
                  onChange={(e) => setNewCredKey(e.target.value)}
                  placeholder="Credential key (e.g. TELEGRAM_BOT_TOKEN)"
                  className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono"
                />
                <div className="relative">
                  <Input
                    type={showCredValue ? "text" : "password"}
                    value={newCredValue}
                    onChange={(e) => setNewCredValue(e.target.value)}
                    placeholder="Token or secret value"
                    className="bg-slate-900 border-slate-800 text-white text-[10px] h-8 font-mono pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCredValue(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showCredValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <Button
                  onClick={handleAddChannelCred}
                  disabled={credSaving || !newCredKey.trim() || !newCredValue.trim()}
                  size="sm"
                  className="bg-[#00d9ff]/15 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/25 h-8 text-[10px] font-mono uppercase"
                >
                  {credSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
                  Save &amp; Connect
                </Button>
              </div>
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
    </div>
  );
}
