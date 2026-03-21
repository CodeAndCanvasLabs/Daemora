import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Eye, Plus, Trash2, Loader2, RefreshCw, Pencil,
  Webhook, Zap, Clock, Link2, Copy, CheckCircle2, AlertCircle,
  ChevronDown, ChevronUp
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

interface Channel {
  name: string;
  running: boolean;
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

// Common webhook patterns users can pick from
const PATTERN_PRESETS = [
  { label: "GitHub — Push", value: '{"event": "push"}', desc: "When code is pushed to a repository" },
  { label: "GitHub — Issue Opened", value: '{"action": "opened"}', desc: "When a new issue is created" },
  { label: "GitHub — PR Created", value: '{"action": "opened", "pull_request": "/.*/"}', desc: "When a pull request is opened" },
  { label: "Stripe — Payment Failed", value: '{"type": "payment_intent.payment_failed"}', desc: "When a payment fails" },
  { label: "Stripe — Subscription Canceled", value: '{"type": "customer.subscription.deleted"}', desc: "When a subscription is canceled" },
  { label: "Custom", value: "", desc: "Write your own JSON pattern" },
];

export function Watchers() {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Watcher | null>(null);

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

  const fetchChannels = useCallback(async () => {
    try {
      const res = await apiFetch("/api/channels");
      const data = await res.json();
      setChannels(data.channels || []);
    } catch { /* non-fatal */ }
  }, []);

  const fetchPublicUrl = useCallback(async () => {
    try {
      const res = await apiFetch("/api/health");
      const data = await res.json();
      if (data.publicUrl) setPublicUrl(data.publicUrl);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { fetchWatchers(); fetchChannels(); fetchPublicUrl(); }, [fetchWatchers, fetchChannels, fetchPublicUrl]);

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Give your watcher a name"); return; }
    if (!form.action.trim()) { toast.error("Tell the agent what to do when triggered"); return; }
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
        toast.success("Watcher created — webhook URL shown below");
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
      toast.success(watcher.enabled ? "Watcher paused" : "Watcher activated");
      fetchWatchers();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiFetch(`/api/watchers/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
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

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(null), 2000);
  };

  const getWebhookUrl = (name: string) => {
    const base = publicUrl || window.location.origin;
    return `${base}/hooks/watch/${encodeURIComponent(name)}`;
  };
  const isLocalUrl = !publicUrl || publicUrl.includes("localhost") || publicUrl.includes("127.0.0.1");

  const enabledCount = watchers.filter(w => w.enabled).length;
  const activeChannels = channels.filter(c => c.running);

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
          <Button variant="outline" size="sm" onClick={() => { fetchWatchers(); fetchChannels(); }} className="border-slate-700 text-gray-400 hover:text-white hover:border-slate-500">
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
                {/* Name */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Watcher Name</label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. github-issue-triage" />
                  <p className="text-[10px] text-gray-500 mt-1">Used in the webhook URL. Keep it short, no spaces.</p>
                </div>

                {/* Description */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">What does this watcher do?</label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Triages new GitHub issues and notifies the team" />
                </div>

                {/* Action */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Agent Instructions</label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-20" value={form.action} onChange={e => setForm({ ...form, action: e.target.value })} placeholder="e.g. Read the incoming webhook payload. If it's a new issue, assign a priority label and post a summary to the team channel." />
                  <p className="text-[10px] text-gray-500 mt-1">The full prompt given to the agent when this watcher fires. Be specific.</p>
                </div>

                {/* Channel — dropdown of active channels */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Notify On</label>
                  {activeChannels.length > 0 ? (
                    <Select value={form.channel || "__none__"} onValueChange={v => setForm({ ...form, channel: v === "__none__" ? "" : v })}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                        <SelectValue placeholder="Where should results be sent?" />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem value="__none__">No notification (results stored only)</SelectItem>
                        {activeChannels.map(ch => (
                          <SelectItem key={ch.name} value={ch.name}>{ch.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex items-center gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-md">
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                      <p className="text-xs text-gray-400">No channels active. Results will be stored but not sent anywhere. Enable a channel (Telegram, Discord, etc.) in the Channels page first.</p>
                    </div>
                  )}
                </div>

                {/* Pattern preset */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Match Pattern</label>
                  <Select value={PATTERN_PRESETS.find(p => p.value === form.pattern)?.label || "Custom"} onValueChange={v => {
                    const preset = PATTERN_PRESETS.find(p => p.label === v);
                    if (preset) setForm({ ...form, pattern: preset.value });
                  }}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white mb-2">
                      <SelectValue placeholder="Pick a common pattern or write custom" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700">
                      {PATTERN_PRESETS.map(p => (
                        <SelectItem key={p.label} value={p.label}>
                          <div>
                            <span>{p.label}</span>
                            <span className="text-[10px] text-gray-500 ml-2">{p.desc}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(form.pattern || PATTERN_PRESETS.find(p => p.value === form.pattern)?.label === "Custom") && (
                    <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white font-mono resize-none h-16" value={form.pattern} onChange={e => setForm({ ...form, pattern: e.target.value })} placeholder='{"event": "push"}' />
                  )}
                  <p className="text-[10px] text-gray-500 mt-1">Leave empty to trigger on any incoming webhook. Add a pattern to only fire on matching payloads.</p>
                </div>

                {/* Cooldown */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Cooldown</label>
                  <Select value={form.cooldownSeconds} onValueChange={v => setForm({ ...form, cooldownSeconds: v })}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700">
                      <SelectItem value="0">No cooldown — fire every time</SelectItem>
                      <SelectItem value="10">10 seconds</SelectItem>
                      <SelectItem value="30">30 seconds</SelectItem>
                      <SelectItem value="60">1 minute</SelectItem>
                      <SelectItem value="300">5 minutes</SelectItem>
                      <SelectItem value="600">10 minutes</SelectItem>
                      <SelectItem value="3600">1 hour</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-gray-500 mt-1">Prevents duplicate triggers. If multiple events arrive within the cooldown window, only the first fires.</p>
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
          <span className="text-xs text-gray-400">Active</span>
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
          <CardContent className="py-12 text-center">
            <Eye className="w-10 h-10 mx-auto mb-3 opacity-30 text-gray-600" />
            <p className="text-gray-400 mb-2">No watchers yet</p>
            <p className="text-xs text-gray-500 max-w-md mx-auto">
              Watchers listen for external events (webhooks from GitHub, Stripe, monitoring tools, etc.) and automatically run an agent task when triggered.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {watchers.map(watcher => {
            const isExpanded = expandedId === watcher.id;
            const webhookUrl = getWebhookUrl(watcher.name);
            return (
            <Card key={watcher.id} className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : watcher.id)}>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-white truncate">{watcher.name}</h3>
                      <Badge className={`text-[10px] ${watcher.enabled ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "bg-slate-700/50 text-gray-500 border-slate-600"}`}>
                        {watcher.enabled ? "Active" : "Paused"}
                      </Badge>
                      {watcher.channel && (
                        <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[10px]">
                          → {watcher.channel}
                        </Badge>
                      )}
                    </div>
                    {watcher.description && (
                      <p className="text-xs text-gray-400 mb-1.5">{watcher.description}</p>
                    )}
                    <div className="flex items-center gap-4 text-[10px] text-gray-500 font-mono">
                      <span>Fired {watcher.triggerCount} time{watcher.triggerCount !== 1 ? "s" : ""}</span>
                      {watcher.lastTriggeredAt && (
                        <span>Last: {new Date(watcher.lastTriggeredAt).toLocaleString()}</span>
                      )}
                      {watcher.cooldownSeconds > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {watcher.cooldownSeconds >= 3600 ? `${watcher.cooldownSeconds / 3600}h` : watcher.cooldownSeconds >= 60 ? `${watcher.cooldownSeconds / 60}m` : `${watcher.cooldownSeconds}s`} cooldown
                        </span>
                      )}
                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Switch
                      checked={!!watcher.enabled}
                      onCheckedChange={() => toggleEnabled(watcher)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white" onClick={() => openEdit(watcher)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-red-400" onClick={() => setDeleteTarget(watcher)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Expanded details — webhook URL, setup info */}
                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                    {/* Agent instructions */}
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase tracking-wider">Agent Instructions</label>
                      <p className="text-xs text-gray-300 mt-1 bg-slate-800/50 rounded p-2">{watcher.action}</p>
                    </div>

                    {/* Pattern */}
                    {watcher.pattern && (
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Match Pattern</label>
                        <pre className="text-xs text-gray-300 mt-1 bg-slate-800/50 rounded p-2 font-mono overflow-x-auto">{JSON.stringify(watcher.pattern, null, 2)}</pre>
                      </div>
                    )}

                    {/* Webhook URL */}
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase tracking-wider">Webhook URL</label>
                      {isLocalUrl && (
                        <div className="flex items-center gap-2 mt-1 mb-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded">
                          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                          <p className="text-[10px] text-amber-300">This is a local URL. External services (GitHub, Stripe) can't reach it. Enable a tunnel in Settings or set DAEMORA_PUBLIC_URL to get a public URL.</p>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 text-xs text-[#00d9ff] bg-slate-800/50 rounded p-2 font-mono truncate">{webhookUrl}</code>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-gray-400 hover:text-white" onClick={() => copyToClipboard(webhookUrl, watcher.id + "-url")}>
                          {copied === watcher.id + "-url" ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    </div>

                    {/* Quick test */}
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase tracking-wider">Test with cURL</label>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 text-[10px] text-gray-400 bg-slate-800/50 rounded p-2 font-mono overflow-x-auto whitespace-nowrap">
                          curl -X POST {webhookUrl} -H "Content-Type: application/json" -d '{"{}"}'
                        </code>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-gray-400 hover:text-white" onClick={() => copyToClipboard(`curl -X POST ${webhookUrl} -H "Content-Type: application/json" -d '{}'`, watcher.id + "-curl")}>
                          {copied === watcher.id + "-curl" ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );})}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <Trash2 className="w-5 h-5" />
              Delete Watcher
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-4">
            <p className="text-sm text-gray-300">
              Are you sure you want to delete <span className="font-semibold text-white">"{deleteTarget?.name}"</span>? External services sending webhooks to this endpoint will get 404 errors.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" size="sm" className="border-slate-700 text-gray-400 hover:text-white" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button size="sm" className="bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30" onClick={confirmDelete}>
                Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
