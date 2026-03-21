import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Eye, Plus, Trash2, Loader2, RefreshCw, Pencil,
  Webhook, Zap, Clock, Link2
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toast } from "sonner";

interface Watcher {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: "webhook" | "event";
  pattern: unknown;
  action: string;
  channel: string | null;
  cooldownSeconds: number;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  action: "",
  triggerType: "webhook" as "webhook" | "event",
  pattern: "",
  channel: "",
  cooldownSeconds: "60",
};

export function Watchers() {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const fetchWatchers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch("/api/watchers");
      const data = await res.json();
      setWatchers(Array.isArray(data) ? data : data.watchers || []);
    } catch (e: any) {
      toast.error("Failed to load watchers: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWatchers(); }, [fetchWatchers]);

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Name required"); return; }
    if (!form.action.trim()) { toast.error("Action required"); return; }
    setSaving(true);
    try {
      let parsedPattern: unknown = null;
      if (form.pattern.trim()) {
        try { parsedPattern = JSON.parse(form.pattern); } catch { toast.error("Pattern must be valid JSON"); setSaving(false); return; }
      }
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        action: form.action.trim(),
        triggerType: form.triggerType,
        pattern: parsedPattern,
        channel: form.channel.trim() || null,
        cooldownSeconds: parseInt(form.cooldownSeconds) || 60,
      };
      if (editingId) {
        await apiFetch(`/api/watchers/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast.success("Watcher updated");
      } else {
        await apiFetch("/api/watchers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast.success("Watcher created");
      }
      setDialogOpen(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM });
      fetchWatchers();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (watcher: Watcher) => {
    try {
      await apiFetch(`/api/watchers/${watcher.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !watcher.enabled }) });
      toast.success(watcher.enabled ? "Watcher disabled" : "Watcher enabled");
      fetchWatchers();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const deleteWatcher = async (id: string) => {
    if (!confirm("Delete this watcher?")) return;
    try {
      await apiFetch(`/api/watchers/${id}`, { method: "DELETE" });
      toast.success("Watcher deleted");
      fetchWatchers();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const openEdit = (w: Watcher) => {
    setEditingId(w.id);
    setForm({
      name: w.name,
      description: w.description || "",
      action: w.action,
      triggerType: w.triggerType,
      pattern: w.pattern ? JSON.stringify(w.pattern, null, 2) : "",
      channel: w.channel || "",
      cooldownSeconds: String(w.cooldownSeconds || 60),
    });
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setDialogOpen(true);
  };

  const enabledCount = watchers.filter(w => w.enabled).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Eye className="w-7 h-7 text-[#00d9ff]" />
            Watchers
          </h2>
          <p className="text-[10px] text-gray-500 font-mono uppercase tracking-[0.3em] mt-1">
            Event-Driven Triggers — When X Happens, Agent Does Y
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchWatchers} className="border-slate-700 text-gray-400 hover:text-white hover:border-slate-500">
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) { setEditingId(null); setForm({ ...EMPTY_FORM }); } }}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={openCreate} className="bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/30">
                <Plus className="w-4 h-4 mr-1" /> New Watcher
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-lg">
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit Watcher" : "New Watcher"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Name</label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. deploy-notifier" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Description</label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What does this watcher do?" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Action</label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-20" value={form.action} onChange={e => setForm({ ...form, action: e.target.value })} placeholder="What should the agent do when triggered?" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Trigger Type</label>
                    <Select value={form.triggerType} onValueChange={v => setForm({ ...form, triggerType: v as any })}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem value="webhook">Webhook</SelectItem>
                        <SelectItem value="event">Event</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Channel</label>
                    <Input className="bg-slate-800 border-slate-700 text-white" value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value })} placeholder="e.g. telegram" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Pattern (JSON)</label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white font-mono resize-none h-16" value={form.pattern} onChange={e => setForm({ ...form, pattern: e.target.value })} placeholder='{"event": "push", "repo": "..."}' />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Cooldown (seconds)</label>
                  <Input type="number" min="0" className="bg-slate-800 border-slate-700 text-white" value={form.cooldownSeconds} onChange={e => setForm({ ...form, cooldownSeconds: e.target.value })} />
                </div>
                <Button onClick={handleSave} disabled={saving} className="w-full bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/30">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  {editingId ? "Update Watcher" : "Create Watcher"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats */}
      <div className="flex gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg">
          <span className="text-xs text-gray-400">Total</span>
          <span className="text-sm font-mono text-white">{watchers.length}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg">
          <div className="w-2 h-2 bg-emerald-400 rounded-full" />
          <span className="text-xs text-gray-400">Enabled</span>
          <span className="text-sm font-mono text-emerald-400">{enabledCount}</span>
        </div>
      </div>

      {/* Watchers List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[#00d9ff]" />
        </div>
      ) : watchers.length === 0 ? (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="py-12 text-center text-gray-500">
            <Eye className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No watchers yet. Create one to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {watchers.map(watcher => (
            <Card key={watcher.id} className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-white truncate">{watcher.name}</h3>
                      <Badge className={`text-[10px] ${watcher.triggerType === "webhook" ? "bg-purple-500/20 text-purple-400 border-purple-500/30" : "bg-amber-500/20 text-amber-400 border-amber-500/30"}`}>
                        {watcher.triggerType === "webhook" ? <Webhook className="w-2.5 h-2.5 mr-1" /> : <Zap className="w-2.5 h-2.5 mr-1" />}
                        {watcher.triggerType}
                      </Badge>
                      {watcher.channel && (
                        <Badge className="bg-slate-700/50 text-gray-400 border-slate-600 text-[10px]">
                          {watcher.channel}
                        </Badge>
                      )}
                    </div>
                    {watcher.description && (
                      <p className="text-xs text-gray-400 mb-1.5">{watcher.description}</p>
                    )}
                    <p className="text-xs text-gray-500 mb-2 truncate max-w-xl">{watcher.action}</p>
                    <div className="flex items-center gap-4 text-[10px] text-gray-500 font-mono">
                      {watcher.triggerType === "webhook" && (
                        <span className="flex items-center gap-1 text-purple-400/70">
                          <Link2 className="w-3 h-3" />
                          /hooks/watch/{watcher.name}
                        </span>
                      )}
                      <span>Triggers: {watcher.triggerCount}</span>
                      {watcher.lastTriggeredAt && (
                        <span>Last: {new Date(watcher.lastTriggeredAt).toLocaleString()}</span>
                      )}
                      {watcher.cooldownSeconds > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {watcher.cooldownSeconds}s cooldown
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Switch
                      checked={watcher.enabled}
                      onCheckedChange={() => toggleEnabled(watcher)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white" onClick={() => openEdit(watcher)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-red-400" onClick={() => deleteWatcher(watcher.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
