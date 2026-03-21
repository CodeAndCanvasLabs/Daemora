import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Target, Plus, Trash2, Loader2, Play, Pause, RefreshCw,
  AlertTriangle, CheckCircle2, XCircle, Pencil, Clock
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { toast } from "sonner";

interface Goal {
  id: string;
  title: string;
  description: string | null;
  strategy: string | null;
  status: "active" | "paused" | "completed" | "failed";
  priority: number;
  checkSchedule: string;
  timezone: string | null;
  maxFailures: number;
  consecutiveFailures: number;
  lastCheckAt: string | null;
  lastResult: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  paused: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  completed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
};

const EMPTY_FORM = {
  title: "",
  description: "",
  strategy: "",
  checkSchedule: "0 */4 * * *",
  timezone: "",
  priority: "5",
  maxFailures: "5",
};

export function Goals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const fetchGoals = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch("/api/goals");
      const data = await res.json();
      setGoals(Array.isArray(data) ? data : data.goals || []);
    } catch (e: any) {
      toast.error("Failed to load goals: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  const handleSave = async () => {
    if (!form.title.trim()) { toast.error("Title required"); return; }
    setSaving(true);
    try {
      const body: any = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        strategy: form.strategy.trim() || null,
        checkSchedule: form.checkSchedule.trim(),
        timezone: form.timezone.trim() || null,
        priority: parseInt(form.priority) || 5,
        maxFailures: parseInt(form.maxFailures) || 5,
      };
      if (editingId) {
        await apiFetch(`/api/goals/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast.success("Goal updated");
      } else {
        await apiFetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        toast.success("Goal created");
      }
      setDialogOpen(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM });
      fetchGoals();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (goal: Goal) => {
    const newStatus = goal.status === "active" ? "paused" : "active";
    try {
      await apiFetch(`/api/goals/${goal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: newStatus }) });
      toast.success(newStatus === "paused" ? "Goal paused" : "Goal resumed");
      fetchGoals();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const deleteGoal = async (id: string) => {
    if (!confirm("Delete this goal?")) return;
    try {
      await apiFetch(`/api/goals/${id}`, { method: "DELETE" });
      toast.success("Goal deleted");
      fetchGoals();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const checkNow = async (id: string) => {
    setCheckingId(id);
    try {
      await apiFetch(`/api/goals/${id}/check`, { method: "POST" });
      toast.success("Check triggered");
      fetchGoals();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setCheckingId(null);
    }
  };

  const openEdit = (goal: Goal) => {
    setEditingId(goal.id);
    setForm({
      title: goal.title,
      description: goal.description || "",
      strategy: goal.strategy || "",
      checkSchedule: goal.checkSchedule || "0 */4 * * *",
      timezone: goal.timezone || "",
      priority: String(goal.priority || 5),
      maxFailures: String(goal.maxFailures || 5),
    });
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setDialogOpen(true);
  };

  const activeCount = goals.filter(g => g.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Target className="w-7 h-7 text-[#00d9ff]" />
            Goals
          </h2>
          <p className="text-[10px] text-gray-500 font-mono uppercase tracking-[0.3em] mt-1">
            Autonomous Objectives — Agent Works Toward Them 24/7
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchGoals} className="border-slate-700 text-gray-400 hover:text-white hover:border-slate-500">
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) { setEditingId(null); setForm({ ...EMPTY_FORM }); } }}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={openCreate} className="bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/30">
                <Plus className="w-4 h-4 mr-1" /> New Goal
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-lg">
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit Goal" : "New Goal"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Title</label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Monitor competitor pricing" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Description</label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-20" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What should the agent accomplish?" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Strategy</label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-16" value={form.strategy} onChange={e => setForm({ ...form, strategy: e.target.value })} placeholder="How should the agent approach this?" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Check Schedule (cron)</label>
                    <Input className="bg-slate-800 border-slate-700 text-white font-mono text-xs" value={form.checkSchedule} onChange={e => setForm({ ...form, checkSchedule: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Timezone</label>
                    <Input className="bg-slate-800 border-slate-700 text-white" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} placeholder="e.g. America/New_York" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Priority (1-10)</label>
                    <Input type="number" min="1" max="10" className="bg-slate-800 border-slate-700 text-white" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Max Failures</label>
                    <Input type="number" min="1" className="bg-slate-800 border-slate-700 text-white" value={form.maxFailures} onChange={e => setForm({ ...form, maxFailures: e.target.value })} />
                  </div>
                </div>
                <Button onClick={handleSave} disabled={saving} className="w-full bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/30">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  {editingId ? "Update Goal" : "Create Goal"}
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
          <span className="text-sm font-mono text-white">{goals.length}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg">
          <div className="w-2 h-2 bg-emerald-400 rounded-full" />
          <span className="text-xs text-gray-400">Active</span>
          <span className="text-sm font-mono text-emerald-400">{activeCount}</span>
        </div>
      </div>

      {/* Goals List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[#00d9ff]" />
        </div>
      ) : goals.length === 0 ? (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="py-12 text-center text-gray-500">
            <Target className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No goals yet. Create one to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {goals.map(goal => (
            <Card key={goal.id} className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-white truncate">{goal.title}</h3>
                      <Badge className={`text-[10px] ${STATUS_COLORS[goal.status] || STATUS_COLORS.active}`}>
                        {goal.status}
                      </Badge>
                      <Badge className="bg-slate-700/50 text-gray-400 border-slate-600 text-[10px]">
                        P{goal.priority}
                      </Badge>
                    </div>
                    {goal.description && (
                      <p className="text-xs text-gray-400 mb-2 line-clamp-2">{goal.description}</p>
                    )}
                    <div className="flex items-center gap-4 text-[10px] text-gray-500 font-mono">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {goal.checkSchedule}
                      </span>
                      {goal.lastCheckAt && (
                        <span>Last: {new Date(goal.lastCheckAt).toLocaleString()}</span>
                      )}
                      {goal.consecutiveFailures > 0 && (
                        <span className="text-red-400 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          {goal.consecutiveFailures} failures
                        </span>
                      )}
                    </div>
                    {goal.lastResult && (
                      <p className="text-[10px] text-gray-500 mt-1 truncate max-w-xl">{goal.lastResult}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Switch
                      checked={goal.status === "active"}
                      onCheckedChange={() => toggleStatus(goal)}
                      className="data-[state=checked]:bg-emerald-500"
                    />
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-[#00d9ff]" onClick={() => checkNow(goal.id)} disabled={checkingId === goal.id}>
                      {checkingId === goal.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white" onClick={() => openEdit(goal)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-red-400" onClick={() => deleteGoal(goal.id)}>
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
