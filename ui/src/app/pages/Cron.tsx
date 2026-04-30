import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Clock, Plus, Trash2, Loader2, Play, Pause, RotateCcw, History,
  Globe, Repeat, Timer, AlertTriangle, CheckCircle2, XCircle, RefreshCw,
  Send, Check, Pencil, Users
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Switch } from "../components/ui/switch";
import { toast } from "sonner";
import { SchedulePicker } from "../components/SchedulePicker";

interface CronJob {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  schedule: {
    kind: "cron" | "every" | "at";
    expr: string | null;
    tz: string | null;
    everyMs: number | null;
    at: string | null;
    staggerMs: number;
  };
  taskInput: string;
  model: string | null;
  timeoutSeconds: number;
  delivery: { mode: string; channel: string | null; to: string | null };
  maxRetries: number;
  failureAlert: unknown;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  runCount: number;
  runningSince: string | null;
  tenantId: string | null;
  createdAt: string;
}

interface CronRun {
  id: number;
  job_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  duration_ms: number | null;
  error: string | null;
  result_preview: string | null;
  delivery_status: string;
  retry_attempt: number;
}

interface SchedulerStatus {
  running: boolean;
  totalJobs: number;
  enabledJobs: number;
  runningNow: number;
  nextWakeAt: string | null;
}

interface DeliveryTarget {
  tenantId: string | null;
  channel: string;
  userId: string | null;
  channelMeta?: Record<string, unknown> | null;
}

interface ChannelDestination {
  channel: string;
  label: string;
  channelMeta: Record<string, unknown> | null;
}

interface Preset {
  id: string;
  name: string;
  description: string | null;
  targets: DeliveryTarget[];
  createdAt: string;
}

const EMPTY_FORM = {
  name: "",
  scheduleKind: "cron" as "cron" | "every" | "at",
  cronExpr: "",
  timezone: "",
  everyInterval: "",
  atTime: "",
  taskInput: "",
  model: "",
  maxRetries: "0",
  timeoutSeconds: "7200",
  deliveryMode: "none",
};

export function Cron() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [activeTab, setActiveTab] = useState("jobs");
  // Delivery targets
  const [destinations, setDestinations] = useState<ChannelDestination[]>([]);
  const [selectedDestinations, setSelectedDestinations] = useState<ChannelDestination[]>([]);
  // Presets
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetForm, setPresetForm] = useState({ name: "", description: "" });
  const [isPresetOpen, setIsPresetOpen] = useState(false);
  // Edit job
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const [jobsRes, statusRes] = await Promise.all([
        apiFetch("/api/cron/jobs"),
        apiFetch("/api/cron/status"),
      ]);
      if (jobsRes.ok) setJobs((await jobsRes.json()).jobs || []);
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (e) {
      console.error("Failed to fetch cron data", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchRuns = useCallback(async (jobId?: string) => {
    try {
      const url = jobId ? `/api/cron/jobs/${jobId}/runs?limit=50` : "/api/cron/runs?limit=50";
      const res = await apiFetch(url);
      if (res.ok) setRuns((await res.json()).runs || []);
    } catch (e) {
      console.error("Failed to fetch runs", e);
    }
  }, []);

  const fetchDeliveryTargets = useCallback(async () => {
    try {
      const [destRes, presetsRes] = await Promise.all([
        apiFetch("/api/channels/destinations"),
        apiFetch("/api/cron/presets"),
      ]);
      if (destRes.ok) {
        const d = await destRes.json();
        const list = (d.destinations || [])
          .filter((x: ChannelDestination) => x.channelMeta)
          .map((x: ChannelDestination) => {
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
      }
      if (presetsRes.ok) setPresets((await presetsRes.json()).presets || []);
    } catch {}
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    if (activeTab === "history") fetchRuns(selectedJobId || undefined);
    if (activeTab === "presets") fetchDeliveryTargets();
  }, [activeTab, selectedJobId, fetchRuns, fetchDeliveryTargets]);

  useEffect(() => {
    if (isAddOpen) fetchDeliveryTargets();
  }, [isAddOpen, fetchDeliveryTargets]);

  const handleCreate = async () => {
    if (!form.taskInput) return toast.error("Task input is required");

    const body: Record<string, unknown> = {
      name: form.name || undefined,
      taskInput: form.taskInput,
      model: form.model || undefined,
      maxRetries: parseInt(form.maxRetries) || 0,
      timeoutSeconds: parseInt(form.timeoutSeconds) || 7200,
    };

    if (form.scheduleKind === "cron") {
      if (!form.cronExpr) return toast.error("Cron expression is required");
      body.schedule = { kind: "cron", expr: form.cronExpr, tz: form.timezone || null };
    } else if (form.scheduleKind === "every") {
      if (!form.everyInterval) return toast.error("Interval is required");
      body.every = form.everyInterval;
    } else if (form.scheduleKind === "at") {
      if (!form.atTime) return toast.error("Date/time is required");
      body.at = new Date(form.atTime).toISOString();
    }

    if (form.deliveryMode === "preset" && selectedPresetId) {
      body.delivery = { mode: "preset", presetId: selectedPresetId };
    } else if (form.deliveryMode === "channels" && selectedDestinations.length > 0) {
      const targets: DeliveryTarget[] = selectedDestinations.map(d => ({
        tenantId: null,
        channel: d.channel,
        userId: (d.channelMeta?.userId as string) || (d.channelMeta?.chatId as string) || null,
        channelMeta: d.channelMeta,
      }));
      body.delivery = { mode: "multi", targets };
    } else if (form.deliveryMode === "webhook") {
      body.delivery = { mode: "webhook" };
    }

    try {
      const res = await apiFetch("/api/cron/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Job created");
        setIsAddOpen(false);
        setForm(EMPTY_FORM);
        fetchJobs();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to create job");
      }
    } catch {
      toast.error("API connection error");
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const res = await apiFetch(`/api/cron/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        toast.success(enabled ? "Job enabled" : "Job paused");
        fetchJobs();
      }
    } catch {
      toast.error("Failed to update job");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/cron/jobs/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Job deleted");
        fetchJobs();
      }
    } catch {
      toast.error("Failed to delete job");
    }
  };

  const handleForceRun = async (id: string) => {
    try {
      const res = await apiFetch(`/api/cron/jobs/${id}/run`, { method: "POST" });
      if (res.ok) {
        toast.success("Job triggered");
        setTimeout(fetchJobs, 2000);
      }
    } catch {
      toast.error("Failed to trigger job");
    }
  };

  const handleEdit = (job: CronJob) => {
    setEditingJobId(job.id);
    const everyMs = job.schedule.everyMs;
    let everyInterval = "";
    if (everyMs) {
      if (everyMs >= 86400000) everyInterval = `${Math.round(everyMs / 86400000)}d`;
      else if (everyMs >= 3600000) everyInterval = `${Math.round(everyMs / 3600000)}h`;
      else if (everyMs >= 60000) everyInterval = `${Math.round(everyMs / 60000)}m`;
      else everyInterval = `${Math.round(everyMs / 1000)}s`;
    }
    // Map server "multi" mode → UI "channels" mode (which uses active channel destinations)
    const uiMode = job.delivery?.mode === "multi" ? "channels" : (job.delivery?.mode || "none");
    setForm({
      name: job.name || "",
      scheduleKind: job.schedule.kind,
      cronExpr: job.schedule.expr || "",
      timezone: job.schedule.tz || "",
      everyInterval,
      atTime: job.schedule.at ? new Date(job.schedule.at).toISOString().slice(0, 16) : "",
      taskInput: job.taskInput || "",
      model: job.model || "",
      maxRetries: String(job.maxRetries || 0),
      timeoutSeconds: String(job.timeoutSeconds || 7200),
      deliveryMode: uiMode,
    });
    if (job.delivery?.mode === "preset" && (job.delivery as any).presetId) {
      setSelectedPresetId((job.delivery as any).presetId);
    }
    if (job.delivery?.mode === "multi" && (job.delivery as any).targets) {
      const existingTargets = (job.delivery as any).targets as Array<{ channel: string; channelMeta: Record<string, unknown> | null }>;
      setSelectedDestinations(existingTargets.map(t => ({
        channel: t.channel,
        label: `${t.channel} → ${(t.channelMeta?.userName as string) || (t.channelMeta?.userId as string) || (t.channelMeta?.chatId as string) || "user"}`,
        channelMeta: t.channelMeta,
      })));
    }
    fetchDeliveryTargets();
    setIsEditOpen(true);
  };

  const handleUpdate = async () => {
    if (!editingJobId || !form.taskInput) return toast.error("Task input is required");

    const body: Record<string, unknown> = {
      name: form.name || undefined,
      taskInput: form.taskInput,
      model: form.model || null,
      maxRetries: parseInt(form.maxRetries) || 0,
      timeoutSeconds: parseInt(form.timeoutSeconds) || 7200,
    };

    if (form.scheduleKind === "cron") {
      if (!form.cronExpr) return toast.error("Cron expression is required");
      body.schedule = { kind: "cron", expr: form.cronExpr, tz: form.timezone || null };
    } else if (form.scheduleKind === "every") {
      if (!form.everyInterval) return toast.error("Interval is required");
      // Parse interval to ms for direct schedule object
      const match = form.everyInterval.match(/^(\d+)\s*(s|m|h|d)$/i);
      if (!match) return toast.error('Invalid interval format (e.g. "30s", "5m", "2h", "1d")');
      const n = parseInt(match[1]);
      const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      body.schedule = { kind: "every", everyMs: n * mult[match[2].toLowerCase()] };
    } else if (form.scheduleKind === "at") {
      if (!form.atTime) return toast.error("Date/time is required");
      body.schedule = { kind: "at", at: new Date(form.atTime).toISOString() };
    }

    if (form.deliveryMode === "preset" && selectedPresetId) {
      body.delivery = { mode: "preset", presetId: selectedPresetId };
    } else if (form.deliveryMode === "channels" && selectedDestinations.length > 0) {
      const targets: DeliveryTarget[] = selectedDestinations.map(d => ({
        tenantId: null,
        channel: d.channel,
        userId: (d.channelMeta?.userId as string) || (d.channelMeta?.chatId as string) || null,
        channelMeta: d.channelMeta,
      }));
      body.delivery = { mode: "multi", targets };
    } else if (form.deliveryMode === "webhook") {
      body.delivery = { mode: "webhook" };
    } else if (form.deliveryMode === "none") {
      body.delivery = { mode: "none" };
    }

    try {
      const res = await apiFetch(`/api/cron/jobs/${editingJobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("Job updated");
        setIsEditOpen(false);
        setEditingJobId(null);
        setForm(EMPTY_FORM);
        fetchJobs();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to update job");
      }
    } catch {
      toast.error("API connection error");
    }
  };

  const formatSchedule = (s: CronJob["schedule"]) => {
    if (s.kind === "cron") return s.expr || "";
    if (s.kind === "every" && s.everyMs) {
      const secs = s.everyMs / 1000;
      if (secs >= 86400) return `every ${Math.round(secs / 86400)}d`;
      if (secs >= 3600) return `every ${Math.round(secs / 3600)}h`;
      if (secs >= 60) return `every ${Math.round(secs / 60)}m`;
      return `every ${secs}s`;
    }
    if (s.kind === "at") return `at ${new Date(s.at!).toLocaleString()}`;
    return "unknown";
  };

  const statusIcon = (s: string | null) => {
    if (s === "ok") return <CheckCircle2 className="w-3 h-3 text-emerald-400" />;
    if (s === "error" || s === "timeout") return <XCircle className="w-3 h-3 text-red-400" />;
    if (s === "skipped") return <Pause className="w-3 h-3 text-yellow-400" />;
    return <Clock className="w-3 h-3 text-gray-600" />;
  };

  const kindIcon = (kind: string) => {
    if (kind === "cron") return <Repeat className="w-3 h-3" />;
    if (kind === "every") return <Timer className="w-3 h-3" />;
    return <Clock className="w-3 h-3" />;
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
          <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Scheduler</h2>
          <p className="text-gray-400 text-sm tracking-widest">SCHEDULED JOBS & RUN HISTORY</p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={fetchJobs} variant="ghost" size="sm" className="text-gray-400 hover:text-[#00d9ff] font-mono text-[10px] uppercase">
            <RefreshCw className="w-3 h-3 mr-2" />
            Refresh
          </Button>
          <Dialog open={isAddOpen} onOpenChange={(v) => { setIsAddOpen(v); if (!v) { setSelectedDestinations([]); setSelectedPresetId(""); } }}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white uppercase text-xs tracking-tighter">
                <Plus className="w-3 h-3 mr-2" />
                New Job
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-950 border-slate-800 text-white max-w-3xl">
              <DialogHeader>
                <DialogTitle className="uppercase tracking-widest text-sm border-b border-slate-800 pb-4">Create Scheduled Job</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4 max-h-[70vh] overflow-y-auto">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Name</label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Daily Report" className="bg-slate-900 border-slate-800 text-sm" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Schedule</label>
                  <SchedulePicker
                    showOnce={true}
                    defaultMode={form.scheduleKind === "at" ? "once" : form.scheduleKind === "every" ? "recurring" : "recurring"}
                    value={{
                      cronExpression: form.scheduleKind === "cron" ? form.cronExpr : undefined,
                      every: form.scheduleKind === "every" ? form.everyInterval : undefined,
                      at: form.scheduleKind === "at" ? (form.atTime ? new Date(form.atTime).toISOString() : undefined) : undefined,
                      timezone: form.timezone,
                    }}
                    onChange={(v) => {
                      if (v.at) {
                        setForm({ ...form, scheduleKind: "at", atTime: v.at.slice(0, 16), timezone: v.timezone || form.timezone });
                      } else if (v.every) {
                        setForm({ ...form, scheduleKind: "every", everyInterval: v.every, timezone: v.timezone || form.timezone });
                      } else if (v.cronExpression) {
                        setForm({ ...form, scheduleKind: "cron", cronExpr: v.cronExpression, timezone: v.timezone || form.timezone });
                      }
                    }}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Task Input (Agent Prompt)</label>
                  <textarea
                    value={form.taskInput}
                    onChange={(e) => setForm({ ...form, taskInput: e.target.value })}
                    placeholder="What should the agent do when this job runs?"
                    className="w-full bg-slate-900 border border-slate-800 rounded-md text-sm p-3 min-h-[80px] text-white resize-y"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Model (optional)</label>
                    <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="openai:gpt-4.1-mini" className="bg-slate-900 border-slate-800 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Max Retries</label>
                    <Input type="number" value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: e.target.value })} className="bg-slate-900 border-slate-800 text-sm" />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400">Timeout (seconds)</label>
                  <Input type="number" value={form.timeoutSeconds} onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value })} className="bg-slate-900 border-slate-800 text-sm" />
                </div>

                {/* Delivery */}
                <div className="space-y-2 border-t border-slate-800 pt-4">
                  <label className="text-xs text-gray-400 flex items-center gap-1"><Send className="w-3 h-3" /> Delivery</label>
                  <Select value={form.deliveryMode} onValueChange={(v) => { setForm({ ...form, deliveryMode: v }); setSelectedDestinations([]); setSelectedPresetId(""); }}>
                    <SelectTrigger className="bg-slate-900 border-slate-800 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-slate-950 border-slate-800">
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="channels">Active channels</SelectItem>
                      <SelectItem value="preset">Preset (saved group)</SelectItem>
                      <SelectItem value="webhook">Webhook URL</SelectItem>
                    </SelectContent>
                  </Select>

                  {form.deliveryMode === "preset" && (
                    <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
                      <SelectTrigger className="bg-slate-900 border-slate-800 text-sm"><SelectValue placeholder="Select preset..." /></SelectTrigger>
                      <SelectContent className="bg-slate-950 border-slate-800">
                        {presets.map(p => (
                          <SelectItem key={p.id} value={p.id}>{p.name} ({p.targets.length} targets)</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {form.deliveryMode === "channels" && (
                    destinations.length > 0 ? (
                      <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-3 max-h-48 overflow-y-auto space-y-1">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-gray-400">{selectedDestinations.length} selected</span>
                          <button
                            className="text-xs text-[#38bdf8] hover:underline"
                            onClick={() => setSelectedDestinations(selectedDestinations.length === destinations.length ? [] : [...destinations])}
                          >{selectedDestinations.length > 0 ? "Deselect All" : "Select All"}</button>
                        </div>
                        {destinations.map((d, i) => {
                          const isSelected = selectedDestinations.some(s => s.channel === d.channel && JSON.stringify(s.channelMeta) === JSON.stringify(d.channelMeta));
                          return (
                            <label key={`${d.channel}-${i}`} className="flex items-center gap-2 py-1 px-1 hover:bg-slate-800/50 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  if (isSelected) {
                                    setSelectedDestinations(selectedDestinations.filter(s => !(s.channel === d.channel && JSON.stringify(s.channelMeta) === JSON.stringify(d.channelMeta))));
                                  } else {
                                    setSelectedDestinations([...selectedDestinations, d]);
                                  }
                                }}
                                className="accent-[#00d9ff]"
                              />
                              <span className="text-sm text-gray-300">{d.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 p-2.5 bg-slate-900/50 border border-slate-800 rounded-lg">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        <p className="text-xs text-gray-400">No active channel destinations. Send a message on Discord/Telegram first so the system knows where to deliver.</p>
                      </div>
                    )
                  )}
                </div>

                <Button onClick={handleCreate} className="w-full bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white uppercase text-xs tracking-tighter">
                  Create Job
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Edit Job Dialog */}
      <Dialog open={isEditOpen} onOpenChange={(v) => { setIsEditOpen(v); if (!v) { setEditingJobId(null); setForm(EMPTY_FORM); setSelectedDestinations([]); setSelectedPresetId(""); } }}>
        <DialogContent className="bg-slate-950 border-slate-800 text-white max-w-3xl">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-widest text-sm border-b border-slate-800 pb-4">Edit Cron Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4 max-h-[70vh] overflow-y-auto">
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Name</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Daily Report" className="bg-slate-900 border-slate-800 text-sm" />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-gray-400">Schedule</label>
              <SchedulePicker
                showOnce={true}
                defaultMode={form.scheduleKind === "at" ? "once" : form.scheduleKind === "every" ? "recurring" : "recurring"}
                value={{
                  cronExpression: form.scheduleKind === "cron" ? form.cronExpr : undefined,
                  every: form.scheduleKind === "every" ? form.everyInterval : undefined,
                  at: form.scheduleKind === "at" ? (form.atTime ? new Date(form.atTime).toISOString() : undefined) : undefined,
                  timezone: form.timezone,
                }}
                onChange={(v) => {
                  if (v.at) {
                    setForm({ ...form, scheduleKind: "at", atTime: v.at.slice(0, 16), timezone: v.timezone || form.timezone });
                  } else if (v.every) {
                    setForm({ ...form, scheduleKind: "every", everyInterval: v.every, timezone: v.timezone || form.timezone });
                  } else if (v.cronExpression) {
                    setForm({ ...form, scheduleKind: "cron", cronExpr: v.cronExpression, timezone: v.timezone || form.timezone });
                  }
                }}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-gray-400">Task Input (Agent Prompt)</label>
              <textarea
                value={form.taskInput}
                onChange={(e) => setForm({ ...form, taskInput: e.target.value })}
                placeholder="What should the agent do when this job runs?"
                className="w-full bg-slate-900 border border-slate-800 rounded-md text-sm p-3 min-h-[80px] text-white resize-y"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Model (optional)</label>
                <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="openai:gpt-4.1-mini" className="bg-slate-900 border-slate-800 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">Max Retries</label>
                <Input type="number" value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: e.target.value })} className="bg-slate-900 border-slate-800 text-sm" />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-gray-400">Timeout (seconds)</label>
              <Input type="number" value={form.timeoutSeconds} onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value })} className="bg-slate-900 border-slate-800 text-sm" />
            </div>

            {/* Delivery */}
            <div className="space-y-2 border-t border-slate-800 pt-4">
              <label className="text-xs text-gray-400 flex items-center gap-1"><Send className="w-3 h-3" /> Delivery</label>
              <Select value={form.deliveryMode} onValueChange={(v) => { setForm({ ...form, deliveryMode: v }); setSelectedDestinations([]); setSelectedPresetId(""); }}>
                <SelectTrigger className="bg-slate-900 border-slate-800 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-slate-950 border-slate-800">
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="channels">Active channels</SelectItem>
                  <SelectItem value="preset">Preset (saved group)</SelectItem>
                  <SelectItem value="webhook">Webhook URL</SelectItem>
                </SelectContent>
              </Select>

              {form.deliveryMode === "preset" && (
                <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
                  <SelectTrigger className="bg-slate-900 border-slate-800 text-sm"><SelectValue placeholder="Select preset..." /></SelectTrigger>
                  <SelectContent className="bg-slate-950 border-slate-800">
                    {presets.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name} ({p.targets.length} targets)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {form.deliveryMode === "channels" && (
                destinations.length > 0 ? (
                  <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-3 max-h-48 overflow-y-auto space-y-1">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-400">{selectedDestinations.length} selected</span>
                      <button
                        className="text-xs text-[#38bdf8] hover:underline"
                        onClick={() => setSelectedDestinations(selectedDestinations.length === destinations.length ? [] : [...destinations])}
                      >{selectedDestinations.length > 0 ? "Deselect All" : "Select All"}</button>
                    </div>
                    {destinations.map((d, i) => {
                      const isSelected = selectedDestinations.some(s => s.channel === d.channel && JSON.stringify(s.channelMeta) === JSON.stringify(d.channelMeta));
                      return (
                        <label key={`${d.channel}-${i}`} className="flex items-center gap-2 py-1 px-1 hover:bg-slate-800/50 rounded cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {
                              if (isSelected) {
                                setSelectedDestinations(selectedDestinations.filter(s => !(s.channel === d.channel && JSON.stringify(s.channelMeta) === JSON.stringify(d.channelMeta))));
                              } else {
                                setSelectedDestinations([...selectedDestinations, d]);
                              }
                            }}
                            className="accent-[#00d9ff]"
                          />
                          <span className="text-sm text-gray-300">{d.label}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 p-2.5 bg-slate-900/50 border border-slate-800 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <p className="text-xs text-gray-400">No active channel destinations. Send a message on Discord/Telegram first.</p>
                  </div>
                )
              )}
            </div>

            <Button onClick={handleUpdate} className="w-full bg-gradient-to-r from-amber-600 to-amber-500 text-white uppercase text-xs tracking-tighter">
              Update Job
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Status Bar */}
      {status && (
        <div className="flex items-center gap-6 text-xs font-mono text-gray-500">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${status.running ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
            <span className="uppercase">{status.running ? "Running" : "Stopped"}</span>
          </div>
          <span>{status.totalJobs} jobs</span>
          <span>{status.enabledJobs} enabled</span>
          {status.runningNow > 0 && <span className="text-yellow-400">{status.runningNow} running now</span>}
          {status.nextWakeAt && <span>Next: {new Date(status.nextWakeAt).toLocaleString()}</span>}
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-slate-900/50 border border-slate-800">
          <TabsTrigger value="jobs" className="data-[state=active]:bg-slate-800 data-[state=active]:text-white font-mono text-xs uppercase">
            <Clock className="w-3 h-3 mr-2" />Jobs
          </TabsTrigger>
          <TabsTrigger value="history" className="data-[state=active]:bg-slate-800 data-[state=active]:text-white font-mono text-xs uppercase">
            <History className="w-3 h-3 mr-2" />Run History
          </TabsTrigger>
          <TabsTrigger value="presets" className="data-[state=active]:bg-slate-800 data-[state=active]:text-white font-mono text-xs uppercase">
            <Users className="w-3 h-3 mr-2" />Presets
          </TabsTrigger>
        </TabsList>

        {/* Jobs Tab */}
        <TabsContent value="jobs" className="mt-4">
          {jobs.length === 0 ? (
            <Card className="bg-slate-900/50 border-slate-800">
              <CardContent className="py-16 text-center">
                <Clock className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                <p className="text-gray-600 font-mono uppercase text-xs tracking-widest">No cron jobs configured</p>
                <p className="text-gray-700 font-mono text-[10px] mt-2">Create one to schedule recurring agent tasks</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <Card key={job.id} className={`bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors ${job.runningSince ? "border-yellow-500/30" : ""}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        {/* Top row: name + badges */}
                        <div className="flex items-center gap-2 mb-2">
                          {kindIcon(job.schedule.kind)}
                          <span className="font-mono text-sm text-white uppercase tracking-tight truncate">{job.name}</span>
                          <Badge variant="outline" className={`text-[9px] ${job.enabled ? "border-emerald-500/30 text-emerald-400" : "border-gray-700 text-gray-500"}`}>
                            {job.runningSince ? "RUNNING" : job.enabled ? "ENABLED" : "PAUSED"}
                          </Badge>
                          <Badge variant="outline" className="text-[9px] border-[#00d9ff]/20 text-[#00d9ff]">
                            {job.schedule.kind}
                          </Badge>
                          {job.delivery?.mode !== "none" && (
                            <Badge variant="outline" className="text-[9px] border-[#00d9ff]/20 text-[#00d9ff]">
                              {job.delivery.mode}
                            </Badge>
                          )}
                        </div>

                        {/* Schedule info */}
                        <div className="flex items-center gap-4 text-[10px] font-mono text-gray-500 mb-2">
                          <span className="text-[#00ff88]">{formatSchedule(job.schedule)}</span>
                          {job.schedule.tz && (
                            <span className="flex items-center gap-1">
                              <Globe className="w-2.5 h-2.5" />{job.schedule.tz}
                            </span>
                          )}
                          {job.maxRetries > 0 && <span>retries: {job.maxRetries}</span>}
                        </div>

                        {/* Task input preview */}
                        <p className="text-[10px] text-gray-600 font-mono truncate lowercase italic">{job.taskInput}</p>

                        {/* Stats row */}
                        <div className="flex items-center gap-4 mt-2 text-[10px] font-mono text-gray-600">
                          <span className="flex items-center gap-1">{statusIcon(job.lastStatus)} {job.lastStatus || "never run"}</span>
                          <span>runs: {job.runCount}</span>
                          {job.lastDurationMs && <span>{Math.round(job.lastDurationMs / 1000)}s</span>}
                          {job.consecutiveErrors > 0 && (
                            <span className="text-red-400 flex items-center gap-1">
                              <AlertTriangle className="w-2.5 h-2.5" />{job.consecutiveErrors} errors
                            </span>
                          )}
                          {job.nextRunAt && <span>next: {new Date(job.nextRunAt).toLocaleString()}</span>}
                        </div>

                        {/* Error display */}
                        {job.lastError && (
                          <p className="text-[9px] text-red-400/70 font-mono mt-1 truncate">{job.lastError}</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        <Switch
                          checked={job.enabled}
                          onCheckedChange={(v) => handleToggle(job.id, v)}
                          className="data-[state=checked]:bg-emerald-500"
                        />
                        <Button variant="ghost" size="icon" onClick={() => handleForceRun(job.id)} className="text-gray-500 hover:text-[#00d9ff]" title="Run now">
                          <Play className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(job)} className="text-gray-500 hover:text-amber-400" title="Edit">
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => { setSelectedJobId(job.id); setActiveTab("history"); }} className="text-gray-500 hover:text-purple-400" title="View history">
                          <History className="w-3 h-3" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(job.id)} className="text-gray-500 hover:text-red-400" title="Delete">
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="mt-4">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader className="border-b border-slate-800/50 pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <History className="w-5 h-5 text-[#00d9ff]" />
                  <div>
                    <CardTitle className="text-white uppercase tracking-tight text-sm">Run History</CardTitle>
                    <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                      {selectedJobId ? `Job ${selectedJobId.slice(0, 8)}` : "All Jobs"}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selectedJobId && (
                    <Button variant="ghost" size="sm" onClick={() => { setSelectedJobId(null); fetchRuns(); }} className="text-gray-400 hover:text-white font-mono text-[10px] uppercase">
                      Show All
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => fetchRuns(selectedJobId || undefined)} className="text-gray-400 hover:text-[#00d9ff] font-mono text-[10px] uppercase">
                    <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {runs.length === 0 ? (
                <div className="text-center py-12 text-gray-700 font-mono uppercase text-[10px] tracking-widest">No run history</div>
              ) : (
                <div className="space-y-2">
                  {runs.map((run) => (
                    <div key={run.id} className="flex items-center gap-3 p-3 bg-slate-800/20 border border-slate-800/50 rounded-lg text-xs font-mono">
                      {statusIcon(run.status)}
                      <span className="text-gray-400 w-40 shrink-0">{new Date(run.started_at).toLocaleString()}</span>
                      <Badge variant="outline" className={`text-[9px] ${
                        run.status === "ok" ? "border-emerald-500/20 text-emerald-400"
                        : run.status === "error" ? "border-red-500/20 text-red-400"
                        : run.status === "timeout" ? "border-orange-500/20 text-orange-400"
                        : "border-gray-700 text-gray-500"
                      }`}>
                        {run.status}
                      </Badge>
                      {run.duration_ms && <span className="text-gray-600">{Math.round(run.duration_ms / 1000)}s</span>}
                      {run.retry_attempt > 0 && <span className="text-yellow-500">retry #{run.retry_attempt}</span>}
                      {run.delivery_status !== "not-requested" && (
                        <Badge variant="outline" className="text-[9px] border-[#00d9ff]/20 text-[#00d9ff]">{run.delivery_status}</Badge>
                      )}
                      {run.error && <span className="text-red-400/60 truncate flex-1">{run.error}</span>}
                      {run.result_preview && !run.error && <span className="text-gray-600 truncate flex-1">{run.result_preview.slice(0, 80)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        {/* Presets Tab */}
        <TabsContent value="presets" className="mt-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-[#00d9ff]" />
              <span className="text-sm font-mono text-white uppercase tracking-tight">Delivery Presets</span>
              <span className="text-[9px] font-mono text-gray-600">{presets.length} presets</span>
            </div>
            <Dialog open={isPresetOpen} onOpenChange={(v) => { setIsPresetOpen(v); if (!v) { setSelectedDestinations([]); } }}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white uppercase text-xs tracking-tighter">
                  <Plus className="w-3 h-3 mr-2" />New Preset
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-slate-950 border-slate-800 text-white max-w-3xl">
                <DialogHeader>
                  <DialogTitle className="uppercase tracking-widest text-sm border-b border-slate-800 pb-4">Create Delivery Preset</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4 max-h-[70vh] overflow-y-auto">
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Name</label>
                    <Input value={presetForm.name} onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })} placeholder="e.g. team, alerts, daily-digest" className="bg-slate-900 border-slate-800 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-gray-400">Description</label>
                    <Input value={presetForm.description} onChange={(e) => setPresetForm({ ...presetForm, description: e.target.value })} placeholder="Optional description" className="bg-slate-900 border-slate-800 text-sm" />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-gray-400">Select Channel Destinations</label>
                    {destinations.length > 0 ? (
                      <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-3 max-h-48 overflow-y-auto space-y-1">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-gray-400">{selectedDestinations.length} selected</span>
                          <button
                            className="text-xs text-[#38bdf8] hover:underline"
                            onClick={() => setSelectedDestinations(selectedDestinations.length === destinations.length ? [] : [...destinations])}
                          >{selectedDestinations.length > 0 ? "Deselect All" : "Select All"}</button>
                        </div>
                        {destinations.map((d, i) => {
                          const isSelected = selectedDestinations.some(s => s.channel === d.channel && JSON.stringify(s.channelMeta) === JSON.stringify(d.channelMeta));
                          return (
                            <label key={`${d.channel}-${i}`} className="flex items-center gap-2 py-1 px-1 hover:bg-slate-800/50 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  if (isSelected) {
                                    setSelectedDestinations(selectedDestinations.filter(s => !(s.channel === d.channel && JSON.stringify(s.channelMeta) === JSON.stringify(d.channelMeta))));
                                  } else {
                                    setSelectedDestinations([...selectedDestinations, d]);
                                  }
                                }}
                                className="accent-[#00d9ff]"
                              />
                              <span className="text-sm text-gray-300">{d.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 p-2.5 bg-slate-900/50 border border-slate-800 rounded-lg">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                        <p className="text-xs text-gray-400">No active channel destinations. Send a message on Discord/Telegram first.</p>
                      </div>
                    )}
                  </div>

                  <Button
                    onClick={async () => {
                      if (!presetForm.name) return toast.error("Name is required");
                      if (selectedDestinations.length === 0) return toast.error("Select at least one destination");
                      const targets: DeliveryTarget[] = selectedDestinations.map(d => ({
                        tenantId: null,
                        channel: d.channel,
                        userId: (d.channelMeta?.userId as string) || (d.channelMeta?.chatId as string) || null,
                        channelMeta: d.channelMeta,
                      }));
                      try {
                        const res = await apiFetch("/api/cron/presets", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name: presetForm.name, description: presetForm.description || null, targets }),
                        });
                        if (res.ok) {
                          toast.success("Preset created");
                          setIsPresetOpen(false);
                          setPresetForm({ name: "", description: "" });
                          setSelectedDestinations([]);
                          fetchDeliveryTargets();
                        } else {
                          const err = await res.json();
                          toast.error(err.error || "Failed to create preset");
                        }
                      } catch { toast.error("API error"); }
                    }}
                    className="w-full bg-gradient-to-r from-[#0891b2] to-[#0d9488] text-white uppercase text-xs tracking-tighter"
                  >
                    Create Preset
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {presets.length === 0 ? (
            <Card className="bg-slate-900/50 border-slate-800">
              <CardContent className="py-16 text-center">
                <Users className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                <p className="text-gray-600 font-mono uppercase text-xs tracking-widest">No delivery presets</p>
                <p className="text-gray-700 font-mono text-[10px] mt-2">Create presets like "engineers" or "team-leads" for reusable delivery groups</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {presets.map(p => (
                <Card key={p.id} className="bg-slate-900/50 border-slate-800">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Users className="w-3 h-3 text-[#00d9ff]" />
                          <span className="font-mono text-sm text-white uppercase tracking-tight">{p.name}</span>
                          <Badge variant="outline" className="text-[9px] border-[#00d9ff]/20 text-[#00d9ff]">
                            {p.targets.length} targets
                          </Badge>
                        </div>
                        {p.description && <p className="text-[10px] text-gray-600 font-mono">{p.description}</p>}
                        <div className="flex flex-wrap gap-1 mt-2">
                          {p.targets.map((t, i) => (
                            <span key={i} className="text-[9px] bg-slate-800/50 px-2 py-0.5 rounded text-gray-400">
                              {t.tenantId ? `${t.tenantId.split(":").pop()}:${t.channel}` : `global:${t.channel}`}
                            </span>
                          ))}
                        </div>
                      </div>
                      <Button
                        variant="ghost" size="icon"
                        onClick={async () => {
                          try {
                            await apiFetch(`/api/cron/presets/${p.id}`, { method: "DELETE" });
                            toast.success("Preset deleted");
                            fetchDeliveryTargets();
                          } catch { toast.error("Failed to delete"); }
                        }}
                        className="text-gray-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
