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
  triggerType: "webhook" | "integration" | "event" | "poll" | "file" | "cron";
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

interface Destination {
  channel: string;
  label: string;
  tenantId: string | null;
  channelMeta: Record<string, unknown> | null;
}

interface WatcherTemplate {
  id: string;
  category: string;
  name: string;
  label: string;
  description: string;
  pattern: unknown;
  cooldownSeconds: number;
  action: string;
  contextHint: string;
}

interface IntegrationEventSpec {
  integration: string;
  event: string;
  label: string;
  description: string;
  params: Array<{ key: string; label: string; required: boolean; hint?: string }>;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  action: "",
  triggerType: "webhook" as "webhook" | "integration",
  pattern: "",
  context: "",
  destinations: [] as Destination[],
  cooldownSeconds: "60",
  // Integration-event trigger fields (only used when triggerType === "integration").
  integration: "",
  event: "",
  eventParams: {} as Record<string, string>,
  pollIntervalSeconds: "300",
};

// Common webhook patterns users can pick from
const PATTERN_PRESETS = [
  { label: "GitHub - Push", value: '{"event": "push"}', desc: "When code is pushed to a repository" },
  { label: "GitHub - Issue Opened", value: '{"action": "opened"}', desc: "When a new issue is created" },
  { label: "GitHub - PR Created", value: '{"action": "opened", "pull_request": "/.*/"}', desc: "When a pull request is opened" },
  { label: "Stripe - Payment Failed", value: '{"type": "payment_intent.payment_failed"}', desc: "When a payment fails" },
  { label: "Stripe - Subscription Canceled", value: '{"type": "customer.subscription.deleted"}', desc: "When a subscription is canceled" },
  { label: "Custom", value: "", desc: "Write your own JSON pattern" },
];

export function Watchers() {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [templates, setTemplates] = useState<WatcherTemplate[]>([]);
  const [eventsCatalogue, setEventsCatalogue] = useState<IntegrationEventSpec[]>([]);
  const [unavailableIntegrations, setUnavailableIntegrations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [webhookToken, setWebhookToken] = useState<string | null>(null);
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
    try {
      const res = await apiFetch("/api/channels/destinations");
      const data = await res.json();
      const list = (data.destinations || []).map((x: Destination) => {
        const m = x.channelMeta as Record<string, unknown> | null;
        const who =
          (m?.authorUsername as string) ||
          (m?.userName as string) ||
          (m?.username as string) ||
          (m?.chatId as string) ||
          (m?.userId as string) ||
          "user";
        return { ...x, label: x.label || `${x.channel} → ${who}` };
      });
      setDestinations(list);
    } catch { /* non-fatal */ }
    try {
      const res = await apiFetch("/api/watchers/templates");
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch { /* non-fatal */ }
    try {
      const res = await apiFetch("/api/watchers/integration-events");
      const data = await res.json();
      setEventsCatalogue(data.events || []);
      setUnavailableIntegrations(data.unavailableIntegrations || []);
    } catch { /* non-fatal */ }
  }, []);

  const fetchPublicUrl = useCallback(async () => {
    try {
      const res = await apiFetch("/api/health");
      const data = await res.json();
      if (data.publicUrl) setPublicUrl(data.publicUrl);
      if (data.webhookToken) setWebhookToken(data.webhookToken);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { fetchWatchers(); fetchChannels(); fetchPublicUrl(); }, [fetchWatchers, fetchChannels, fetchPublicUrl]);

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Give your watcher a name"); return; }
    if (!form.action.trim()) { toast.error("Tell the agent what to do when triggered"); return; }
    setSaving(true);
    try {
      let parsedPattern: Record<string, unknown> | null = null;
      if (form.triggerType === "integration") {
        if (!form.integration || !form.event) {
          toast.error("Pick an integration and an event");
          setSaving(false);
          return;
        }
        const spec = eventsCatalogue.find((e) => e.integration === form.integration && e.event === form.event);
        const missing = spec?.params.filter((p) => p.required && !form.eventParams[p.key]?.trim()) ?? [];
        if (missing.length > 0) {
          toast.error(`Missing: ${missing.map((m) => m.label).join(", ")}`);
          setSaving(false);
          return;
        }
        const intervalMs = Math.max(30, parseInt(form.pollIntervalSeconds) || 300) * 1000;
        const cleanParams: Record<string, string> = {};
        for (const [k, v] of Object.entries(form.eventParams)) {
          const s = String(v ?? "").trim();
          if (s) cleanParams[k] = s;
        }
        parsedPattern = {
          __integration: form.integration,
          __event: form.event,
          __intervalMs: intervalMs,
          __params: cleanParams,
        };
      } else if (form.pattern.trim()) {
        try { parsedPattern = JSON.parse(form.pattern); } catch { toast.error("Pattern must be valid JSON"); setSaving(false); return; }
      }
      const body: any = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        action: form.action.trim(),
        triggerType: form.triggerType,
        pattern: parsedPattern,
        destinations: form.destinations.filter(d => d.channelMeta),
        channel: form.destinations[0]?.channel || null,
        channelMeta: form.destinations[0]?.channelMeta || null,
        context: form.context.trim() || null,
        cooldownSeconds: parseInt(form.cooldownSeconds) || 60,
      };
      if (editingId) {
        await apiFetch(`/api/watchers/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast.success("Watcher updated");
      } else {
        await apiFetch("/api/watchers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast.success("Watcher created - webhook URL shown below");
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
    // Normalize the stored triggerType to the 2-way form union. Legacy
    // "event" rows and any poll/file/cron variants collapse to
    // "webhook" for editing — the user can still see the pattern JSON.
    const formTrigger: "webhook" | "integration" =
      w.triggerType === "integration" ? "integration" : "webhook";
    // If integration-backed, extract __integration / __event / __params
    // back out of the stored pattern so the form fields hydrate.
    const p = (w.pattern ?? {}) as Record<string, unknown>;
    const isInt = formTrigger === "integration";
    const intervalMs = typeof p["__intervalMs"] === "number" ? (p["__intervalMs"] as number) : 300_000;
    setForm({
      name: w.name,
      description: w.description || "",
      action: w.action,
      triggerType: formTrigger,
      pattern: isInt ? "" : (w.pattern ? JSON.stringify(w.pattern, null, 2) : ""),
      destinations: (w as any).destinations || [],
      context: (w as any).context || "",
      cooldownSeconds: String(w.cooldownSeconds || 60),
      integration: isInt ? String(p["__integration"] ?? "") : "",
      event: isInt ? String(p["__event"] ?? "") : "",
      eventParams: isInt ? ((p["__params"] as Record<string, string>) ?? {}) : {},
      pollIntervalSeconds: isInt ? String(Math.round(intervalMs / 1000)) : "300",
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
            Event-Driven Triggers - When X Happens, Agent Does Y
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
                {/* Template picker - only for new watchers */}
                {!editingId && templates.length > 0 && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Start from Template</label>
                    <Select value="__blank__" onValueChange={v => {
                      if (v === "__blank__") return;
                      const t = templates.find(t => t.id === v);
                      if (t) {
                        setForm({
                          ...form,
                          name: t.name,
                          description: t.description,
                          action: t.action,
                          pattern: t.pattern ? JSON.stringify(t.pattern, null, 2) : "",
                          cooldownSeconds: String(t.cooldownSeconds),
                          context: "",
                        });
                      }
                    }}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                        <SelectValue placeholder="Blank (configure manually)" />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700 max-h-64">
                        <SelectItem value="__blank__">Blank - configure manually</SelectItem>
                        {["DevOps", "Business", "General"].map(cat => {
                          const catTemplates = templates.filter(t => t.category === cat);
                          if (catTemplates.length === 0) return null;
                          return catTemplates.map(t => (
                            <SelectItem key={t.id} value={t.id}>
                              <span className="font-medium">{t.label}</span>
                              <span className="text-[10px] text-gray-500 ml-2">{t.description.slice(0, 50)}</span>
                            </SelectItem>
                          ));
                        })}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-gray-500 mt-1">Pre-fills the form. You can edit everything before saving.</p>
                  </div>
                )}

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

                {/* Deliver To - multi-select destinations */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Deliver Results To</label>
                  {destinations.filter(d => d.channelMeta).length > 0 ? (
                    <div className="space-y-2 p-3 bg-slate-800/30 border border-slate-700 rounded-md max-h-48 overflow-y-auto">
                      {destinations.filter(d => d.channelMeta).map((d, i) => {
                        const isSelected = form.destinations.some(
                          fd => fd.channel === d.channel && JSON.stringify(fd.channelMeta) === JSON.stringify(d.channelMeta)
                        );
                        return (
                          <label key={`${d.channel}-${i}`} className="flex items-center gap-3 cursor-pointer hover:bg-slate-700/30 rounded p-1.5 -m-1.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected) {
                                  setForm({ ...form, destinations: form.destinations.filter(
                                    fd => !(fd.channel === d.channel && JSON.stringify(fd.channelMeta) === JSON.stringify(d.channelMeta))
                                  )});
                                } else {
                                  setForm({ ...form, destinations: [...form.destinations, { channel: d.channel, channelMeta: d.channelMeta, label: d.label, tenantId: d.tenantId }] });
                                }
                              }}
                              className="rounded border-slate-600 bg-slate-800 text-[#00d9ff] focus:ring-[#00d9ff]/50"
                            />
                            <span className="text-sm text-gray-300">{d.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : activeChannels.length > 0 ? (
                    <div className="flex items-center gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-md">
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                      <p className="text-xs text-gray-400">Channels are running but no conversations yet. Send a message on Discord/Telegram first so the system knows where to deliver.</p>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 p-2.5 bg-slate-800/50 border border-slate-700 rounded-md">
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                      <p className="text-xs text-gray-400">No channels active. Enable a channel (Telegram, Discord, etc.) in the Channels page first.</p>
                    </div>
                  )}
                  {form.destinations.length > 0 && (
                    <p className="text-[10px] text-[#00d9ff] mt-1">{form.destinations.length} destination{form.destinations.length > 1 ? "s" : ""} selected</p>
                  )}
                  {form.destinations.length === 0 && destinations.filter(d => d.channelMeta).length > 0 && (
                    <p className="text-[10px] text-gray-500 mt-1">No destinations selected - results will be stored only.</p>
                  )}
                </div>

                {/* Trigger source — webhook vs integration event */}
                <div>
                  <label className="text-xs text-gray-400 mb-1.5 block">Trigger Source</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, triggerType: "webhook" })}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${
                        form.triggerType === "webhook"
                          ? "bg-[#00d9ff]/10 border-[#00d9ff]/50 text-[#00d9ff]"
                          : "bg-slate-800/60 border-slate-700 text-gray-400 hover:text-white hover:border-slate-600"
                      }`}
                    >
                      <Webhook className="w-4 h-4" />
                      <span className="flex-1 text-left">Webhook</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, triggerType: "integration" })}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${
                        form.triggerType === "integration"
                          ? "bg-[#00d9ff]/10 border-[#00d9ff]/50 text-[#00d9ff]"
                          : "bg-slate-800/60 border-slate-700 text-gray-400 hover:text-white hover:border-slate-600"
                      }`}
                    >
                      <Zap className="w-4 h-4" />
                      <span className="flex-1 text-left">Integration Event</span>
                    </button>
                  </div>
                </div>

                {/* Integration-event picker (only for triggerType === "integration") */}
                {form.triggerType === "integration" && (
                  <div className="space-y-3 p-3 rounded-md bg-slate-900/40 border border-slate-800">
                    {eventsCatalogue.length === 0 ? (
                      <div className="flex items-start gap-2 text-xs text-amber-400/80">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                          <p>No connected integrations support watcher events yet.</p>
                          {unavailableIntegrations.length > 0 && (
                            <p className="text-gray-500 mt-1">
                              Connect one of: {unavailableIntegrations.join(", ")} — then come back.
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">Integration</label>
                          <Select
                            value={form.integration}
                            onValueChange={(v) => setForm({ ...form, integration: v, event: "", eventParams: {} })}
                          >
                            <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                              <SelectValue placeholder="Pick a connected integration" />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-800 border-slate-700">
                              {Array.from(new Set(eventsCatalogue.map((e) => e.integration))).map((id) => (
                                <SelectItem key={id} value={id}>{id}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {form.integration && (
                          <div>
                            <label className="text-xs text-gray-400 mb-1 block">Event</label>
                            <Select
                              value={form.event}
                              onValueChange={(v) => setForm({ ...form, event: v, eventParams: {} })}
                            >
                              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                                <SelectValue placeholder="Pick an event" />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-800 border-slate-700">
                                {eventsCatalogue
                                  .filter((e) => e.integration === form.integration)
                                  .map((e) => (
                                    <SelectItem key={e.event} value={e.event}>
                                      <div>
                                        <span>{e.label}</span>
                                        <span className="text-[10px] text-gray-500 ml-2">{e.description}</span>
                                      </div>
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {/* Dynamic params for the selected event */}
                        {form.event && (() => {
                          const spec = eventsCatalogue.find((e) => e.integration === form.integration && e.event === form.event);
                          if (!spec || spec.params.length === 0) {
                            return <p className="text-[11px] text-gray-500">No parameters — fires on any matching event for the connected account.</p>;
                          }
                          return (
                            <div className="space-y-2">
                              {spec.params.map((p) => (
                                <div key={p.key}>
                                  <label className="text-[11px] text-gray-400 mb-1 block">
                                    {p.label} {p.required && <span className="text-red-400">*</span>}
                                  </label>
                                  <Input
                                    className="bg-slate-800 border-slate-700 text-white text-sm"
                                    value={form.eventParams[p.key] ?? ""}
                                    onChange={(e) => setForm({ ...form, eventParams: { ...form.eventParams, [p.key]: e.target.value } })}
                                    placeholder={p.hint ?? ""}
                                  />
                                  {p.hint && <p className="text-[10px] text-gray-500 mt-0.5">{p.hint}</p>}
                                </div>
                              ))}
                            </div>
                          );
                        })()}

                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">Poll interval</label>
                          <Select value={form.pollIntervalSeconds} onValueChange={(v) => setForm({ ...form, pollIntervalSeconds: v })}>
                            <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-800 border-slate-700">
                              <SelectItem value="30">30 seconds (min)</SelectItem>
                              <SelectItem value="60">1 minute</SelectItem>
                              <SelectItem value="300">5 minutes</SelectItem>
                              <SelectItem value="900">15 minutes</SelectItem>
                              <SelectItem value="1800">30 minutes</SelectItem>
                              <SelectItem value="3600">1 hour</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-gray-500 mt-1">How often to check the provider. Providers rate-limit — don't go too aggressive.</p>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Match pattern — webhook mode only */}
                {form.triggerType === "webhook" && (
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
                )}

                {/* Cooldown */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Cooldown</label>
                  <Select value={form.cooldownSeconds} onValueChange={v => setForm({ ...form, cooldownSeconds: v })}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700">
                      <SelectItem value="0">No cooldown - fire every time</SelectItem>
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

                {/* Context - project background knowledge */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Project Context <span className="text-gray-600">(optional)</span></label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-16" value={form.context} onChange={e => setForm({ ...form, context: e.target.value })} placeholder="e.g. Repo: daemora/daemora, Stack: Node.js + SQLite, Main branch: main, Team: @umar @ali" />
                  <p className="text-[10px] text-gray-500 mt-1">Background knowledge injected when this watcher fires. Helps the agent understand the project without reading docs every time.</p>
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
                      {((watcher as any).destinations?.length > 0 ? (watcher as any).destinations : watcher.channel ? [{ channel: watcher.channel }] : []).map((d: any, i: number) => (
                        <Badge key={i} className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[10px]">
                          → {d.label || d.channel}
                        </Badge>
                      ))}
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

                {/* Expanded details - webhook URL, setup info */}
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

                    {/* Auth header */}
                    {webhookToken && (
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Auth Header (required)</label>
                        <div className="flex items-center gap-2 mt-1">
                          <code className="flex-1 text-xs text-gray-300 bg-slate-800/50 rounded p-2 font-mono truncate">Authorization: Bearer {webhookToken}</code>
                          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-gray-400 hover:text-white" onClick={() => copyToClipboard(`Bearer ${webhookToken}`, watcher.id + "-token")}>
                            {copied === watcher.id + "-token" ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Quick test */}
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase tracking-wider">Test with cURL</label>
                      <div className="flex items-center gap-2 mt-1">
                        <code className="flex-1 text-[10px] text-gray-400 bg-slate-800/50 rounded p-2 font-mono overflow-x-auto whitespace-nowrap">
                          curl -X POST {webhookUrl} -H "Content-Type: application/json" {webhookToken ? `-H "Authorization: Bearer ${webhookToken}" ` : ""}-d '{"{}"}'
                        </code>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-gray-400 hover:text-white" onClick={() => copyToClipboard(`curl -X POST ${webhookUrl} -H "Content-Type: application/json" ${webhookToken ? `-H "Authorization: Bearer ${webhookToken}" ` : ""}-d '{}'`, watcher.id + "-curl")}>
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
