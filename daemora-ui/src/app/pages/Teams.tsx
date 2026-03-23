import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../api";
import {
  Users, RefreshCw, Loader2, CheckCircle2, XCircle, Clock,
  AlertTriangle, ChevronDown, ChevronUp, Trash2, MessageSquare,
  Target, Pause
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Plus } from "lucide-react";

interface TeamMember {
  id: string; name: string; role: string; profile: string; status: string;
}
interface TeamTask {
  id: string; title: string; status: string; assignee: string | null;
  priority: number; blockedBy: string[]; plan: string | null;
  result: string | null; createdAt: string;
}
interface TeamMessage {
  id: number; from: string; to: string; msgType: string;
  content: string; createdAt: string;
}
interface Team {
  id: string; name: string; status: string; project: string | null;
  projectType: string | null; projectRepo: string | null;
  projectStack: string | null; requirements: string | null;
  createdAt: string; members: TeamMember[]; tasks: TeamTask[];
  messages?: TeamMessage[];
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  completed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  paused: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  disbanded: "bg-red-500/20 text-red-400 border-red-500/30",
  working: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  done: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  idle: "bg-slate-700/50 text-gray-400 border-slate-600",
  pending: "bg-slate-700/50 text-gray-400 border-slate-600",
  assigned: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  plan_submitted: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  in_progress: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  blocked: "bg-red-500/20 text-red-400 border-red-500/30",
};

const TASK_ICONS: Record<string, typeof CheckCircle2> = {
  completed: CheckCircle2,
  failed: XCircle,
  in_progress: Loader2,
  blocked: AlertTriangle,
  pending: Clock,
  assigned: Clock,
  plan_submitted: MessageSquare,
};

export function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);
  const [detailTeam, setDetailTeam] = useState<Team | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [createForm, setCreateForm] = useState({
    name: "", task: "", context: "", projectType: "coding", projectRepo: "", projectStack: "",
    templateId: "", pollInterval: "30",
    workers: [{ name: "", profile: "coder", crew: "", task: "" }],
  });

  const fetchTeams = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch("/api/teams");
      const data = await res.json();
      setTeams(data.teams || []);
    } catch (e: any) {
      toast.error("Failed to load teams: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTeams();
    apiFetch("/api/teams/templates").then(r => r.json()).then(d => setTemplates(d.templates || [])).catch(() => {});
  }, [fetchTeams]);

  const handleCreate = async () => {
    if (!createForm.task) { toast.error("What should this team accomplish?"); return; }
    setCreating(true);
    try {
      const body: any = {
        name: createForm.name || createForm.task.slice(0, 30),
        task: createForm.task,
        context: createForm.context || undefined,
        project: createForm.name || createForm.task.slice(0, 30),
        projectType: createForm.projectType || undefined,
        projectRepo: createForm.projectRepo || undefined,
        projectStack: createForm.projectStack || undefined,
      };
      if (createForm.templateId) {
        body.templateId = createForm.templateId;
      } else {
        body.workers = createForm.workers.filter(w => w.name && w.task).map(w => ({
          name: w.name, task: w.task,
          ...(w.crew ? { crew: w.crew } : { profile: w.profile }),
        }));
        if (body.workers.length === 0) { toast.error("Add at least one worker"); setCreating(false); return; }
      }
      const res = await apiFetch("/api/teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      toast.success("Team launched!");
      setCreateOpen(false);
      setCreateForm({ name: "", task: "", context: "", projectType: "coding", projectRepo: "", projectStack: "", templateId: "", pollInterval: "30", workers: [{ name: "", profile: "coder", crew: "", task: "" }] });
      setTimeout(fetchTeams, 2000);
    } catch (e: any) { toast.error(e.message); } finally { setCreating(false); }
  };

  // Auto-refresh every 10 seconds for live status
  useEffect(() => {
    const interval = setInterval(fetchTeams, 10_000);
    return () => clearInterval(interval);
  }, [fetchTeams]);

  const openDetail = async (teamId: string) => {
    setDetailLoading(true);
    try {
      const res = await apiFetch(`/api/teams/${teamId}`);
      const data = await res.json();
      setDetailTeam(data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setDetailLoading(false);
    }
  };

  const disbandTeam = async (teamId: string) => {
    try {
      await apiFetch(`/api/teams/${teamId}/disband`, { method: "POST" });
      toast.success("Team disbanded");
      fetchTeams();
      setDetailTeam(null);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const activeCount = teams.filter(t => t.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Users className="w-7 h-7 text-[#00d9ff]" />
            Teams
          </h2>
          <p className="text-[10px] text-gray-500 font-mono uppercase tracking-[0.3em] mt-1">
            Project Teams — Lead + Workers Coordination
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchTeams} className="border-slate-700 text-gray-400 hover:text-white hover:border-slate-500">
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/30">
                <Plus className="w-4 h-4 mr-1" /> New Team
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-lg max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Launch a Team</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                {/* Template picker */}
                {templates.length > 0 && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Start from Template</label>
                    <Select value={createForm.templateId || "__custom__"} onValueChange={v => setCreateForm({ ...createForm, templateId: v === "__custom__" ? "" : v })}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem value="__custom__">Custom — define workers manually</SelectItem>
                        {templates.map((t: any) => (
                          <SelectItem key={t.id} value={t.id}>{t.name} — {t.workers?.length} workers</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Project name */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Project Name</label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} placeholder="e.g. auth-system, q4-research" />
                </div>

                {/* Goal */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">What should this team accomplish?</label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-20" value={createForm.task} onChange={e => setCreateForm({ ...createForm, task: e.target.value })} placeholder="Build a complete login system with Google OAuth, including backend API, frontend UI, and tests" />
                </div>

                {/* Project details */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Type</label>
                    <Select value={createForm.projectType} onValueChange={v => setCreateForm({ ...createForm, projectType: v })}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem value="coding">Coding</SelectItem>
                        <SelectItem value="research">Research</SelectItem>
                        <SelectItem value="design">Design</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Stack</label>
                    <Input className="bg-slate-800 border-slate-700 text-white" value={createForm.projectStack} onChange={e => setCreateForm({ ...createForm, projectStack: e.target.value })} placeholder="Node.js, React, PostgreSQL" />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Repo URL <span className="text-gray-600">(optional)</span></label>
                  <Input className="bg-slate-800 border-slate-700 text-white" value={createForm.projectRepo} onChange={e => setCreateForm({ ...createForm, projectRepo: e.target.value })} placeholder="https://github.com/org/repo" />
                </div>

                {/* Context */}
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Additional Context <span className="text-gray-600">(optional)</span></label>
                  <textarea className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white resize-none h-16" value={createForm.context} onChange={e => setCreateForm({ ...createForm, context: e.target.value })} placeholder="Existing codebase uses Express, auth via JWT, database has users table..." />
                </div>

                {/* Workers (custom only) */}
                {!createForm.templateId && (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Workers</label>
                    {createForm.workers.map((w, i) => (
                      <div key={i} className="grid grid-cols-12 gap-2 mb-2">
                        <Input className="col-span-3 bg-slate-800 border-slate-700 text-white text-xs" value={w.name} onChange={e => { const ws = [...createForm.workers]; ws[i].name = e.target.value; setCreateForm({ ...createForm, workers: ws }); }} placeholder="Name" />
                        <Select value={w.profile} onValueChange={v => { const ws = [...createForm.workers]; ws[i].profile = v; setCreateForm({ ...createForm, workers: ws }); }}>
                          <SelectTrigger className="col-span-3 bg-slate-800 border-slate-700 text-white text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent className="bg-slate-800 border-slate-700">
                            {["coder","frontend","tester","researcher","writer","analyst","devops","architect","designer","reviewer"].map(p => (
                              <SelectItem key={p} value={p}>{p}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input className="col-span-5 bg-slate-800 border-slate-700 text-white text-xs" value={w.task} onChange={e => { const ws = [...createForm.workers]; ws[i].task = e.target.value; setCreateForm({ ...createForm, workers: ws }); }} placeholder="Task assignment" />
                        <Button variant="ghost" size="icon" className="col-span-1 h-8 w-8 text-gray-400 hover:text-red-400" onClick={() => { const ws = createForm.workers.filter((_, j) => j !== i); setCreateForm({ ...createForm, workers: ws.length ? ws : [{ name: "", profile: "coder", crew: "", task: "" }] }); }}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" className="border-slate-700 text-gray-400 text-xs" onClick={() => setCreateForm({ ...createForm, workers: [...createForm.workers, { name: "", profile: "coder", crew: "", task: "" }] })}>
                      + Add Worker
                    </Button>
                  </div>
                )}

                <Button onClick={handleCreate} disabled={creating} className="w-full bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30 hover:bg-[#00d9ff]/30">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Launch Team
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
          <span className="text-sm font-mono text-white">{teams.length}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded-lg">
          <div className="w-2 h-2 bg-emerald-400 rounded-full" />
          <span className="text-xs text-gray-400">Active</span>
          <span className="text-sm font-mono text-emerald-400">{activeCount}</span>
        </div>
      </div>

      {/* Team List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[#00d9ff]" />
        </div>
      ) : teams.length === 0 ? (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="py-12 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-30 text-gray-600" />
            <p className="text-gray-400 mb-2">No teams yet</p>
            <p className="text-xs text-gray-500 max-w-md mx-auto">
              Teams are created by the agent when you ask for multi-stage work. Try: "Build a login system with backend, frontend, and tests."
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {teams.map(team => {
            const isExpanded = expandedTeam === team.id;
            const workers = team.members?.filter(m => m.role !== "lead") || [];
            const tasks = team.tasks || [];
            const completedTasks = tasks.filter(t => t.status === "completed").length;
            const totalTasks = tasks.length;

            return (
              <Card key={team.id} className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 cursor-pointer" onClick={() => setExpandedTeam(isExpanded ? null : team.id)}>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-white">{team.project || team.name}</h3>
                        <Badge className={`text-[10px] ${STATUS_COLORS[team.status] || STATUS_COLORS.idle}`}>
                          {team.status}
                        </Badge>
                        {team.projectType && (
                          <Badge className="bg-slate-700/50 text-gray-400 border-slate-600 text-[10px]">
                            {team.projectType}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-[10px] text-gray-500 font-mono">
                        <span>{workers.length} worker{workers.length !== 1 ? "s" : ""}</span>
                        <span>{completedTasks}/{totalTasks} tasks done</span>
                        {team.projectStack && <span>{team.projectStack}</span>}
                        <span>{new Date(team.createdAt).toLocaleDateString()}</span>
                        {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-white" onClick={() => openDetail(team.id)}>
                        <Target className="w-3.5 h-3.5" />
                      </Button>
                      {team.status === "active" && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-red-400" onClick={() => disbandTeam(team.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expanded: workers + tasks */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-slate-800 space-y-4">
                      {/* Workers */}
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Workers</label>
                        <div className="mt-1 space-y-1">
                          {workers.map(m => (
                            <div key={m.id} className="flex items-center gap-2 text-xs">
                              <Badge className={`text-[9px] ${STATUS_COLORS[m.status] || STATUS_COLORS.idle}`}>{m.status}</Badge>
                              <span className="text-white">{m.name}</span>
                              <span className="text-gray-500">{m.profile}</span>
                            </div>
                          ))}
                          {workers.length === 0 && <span className="text-xs text-gray-500">No workers yet</span>}
                        </div>
                      </div>

                      {/* Tasks */}
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider">Tasks</label>
                        <div className="mt-1 space-y-1">
                          {tasks.map(t => {
                            const Icon = TASK_ICONS[t.status] || Clock;
                            return (
                              <div key={t.id} className="flex items-center gap-2 text-xs">
                                <Icon className={`w-3 h-3 ${t.status === "in_progress" ? "animate-spin text-cyan-400" : t.status === "completed" ? "text-emerald-400" : t.status === "failed" ? "text-red-400" : "text-gray-500"}`} />
                                <span className="text-white truncate max-w-xs">{t.title}</span>
                                <span className="text-gray-500">→ {t.assignee || "unassigned"}</span>
                                <Badge className={`text-[9px] ${STATUS_COLORS[t.status] || STATUS_COLORS.pending}`}>{t.status}</Badge>
                              </div>
                            );
                          })}
                          {tasks.length === 0 && <span className="text-xs text-gray-500">No tasks yet</span>}
                        </div>
                      </div>

                      {/* Progress bar */}
                      {totalTasks > 0 && (
                        <div className="w-full bg-slate-800 rounded-full h-1.5">
                          <div className="bg-[#00d9ff] h-1.5 rounded-full transition-all" style={{ width: `${(completedTasks / totalTasks) * 100}%` }} />
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      <Dialog open={!!detailTeam} onOpenChange={(o) => { if (!o) setDetailTeam(null); }}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-[#00d9ff]" />
              {detailTeam?.project || detailTeam?.name}
            </DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <div className="py-8 text-center"><Loader2 className="w-6 h-6 animate-spin text-[#00d9ff] mx-auto" /></div>
          ) : detailTeam && (
            <div className="space-y-4 mt-4">
              {/* Info */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-gray-500">Status:</span> <Badge className={`text-[9px] ml-1 ${STATUS_COLORS[detailTeam.status]}`}>{detailTeam.status}</Badge></div>
                <div><span className="text-gray-500">Type:</span> <span className="text-white ml-1">{detailTeam.projectType || "general"}</span></div>
                {detailTeam.projectRepo && <div className="col-span-2"><span className="text-gray-500">Repo:</span> <span className="text-[#00d9ff] ml-1">{detailTeam.projectRepo}</span></div>}
                {detailTeam.projectStack && <div className="col-span-2"><span className="text-gray-500">Stack:</span> <span className="text-white ml-1">{detailTeam.projectStack}</span></div>}
              </div>

              {/* Requirements */}
              {detailTeam.requirements && (
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider">Requirements</label>
                  <p className="text-xs text-gray-300 mt-1 bg-slate-800/50 rounded p-2">{detailTeam.requirements.slice(0, 500)}</p>
                </div>
              )}

              {/* Members */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Team Members</label>
                <div className="mt-1 space-y-1">
                  {detailTeam.members?.map(m => (
                    <div key={m.id} className="flex items-center gap-2 text-xs bg-slate-800/30 rounded px-2 py-1">
                      <Badge className={`text-[9px] ${STATUS_COLORS[m.status]}`}>{m.status}</Badge>
                      <span className="text-white font-medium">{m.name}</span>
                      <span className="text-gray-500">{m.role} / {m.profile}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tasks */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Tasks</label>
                <div className="mt-1 space-y-1">
                  {detailTeam.tasks?.map(t => (
                    <div key={t.id} className="bg-slate-800/30 rounded px-2 py-1.5">
                      <div className="flex items-center gap-2 text-xs">
                        <Badge className={`text-[9px] ${STATUS_COLORS[t.status]}`}>{t.status}</Badge>
                        <span className="text-white">{t.title}</span>
                        <span className="text-gray-500 ml-auto">{t.assignee}</span>
                      </div>
                      {t.result && <p className="text-[10px] text-gray-400 mt-1 pl-2">Result: {t.result.slice(0, 200)}</p>}
                      {t.plan && <p className="text-[10px] text-gray-500 mt-1 pl-2">Plan: {t.plan.slice(0, 200)}</p>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Messages */}
              {detailTeam.messages && detailTeam.messages.length > 0 && (
                <div>
                  <label className="text-[10px] text-gray-500 uppercase tracking-wider">Recent Messages</label>
                  <div className="mt-1 max-h-48 overflow-y-auto space-y-1">
                    {detailTeam.messages.map(m => (
                      <div key={m.id} className="text-[10px] bg-slate-800/30 rounded px-2 py-1">
                        <span className="text-[#00d9ff]">{m.from}</span>
                        <span className="text-gray-600"> → </span>
                        <span className="text-gray-400">{m.to}</span>
                        <Badge className="text-[8px] ml-1 bg-slate-700/50 text-gray-500 border-slate-600">{m.msgType}</Badge>
                        <p className="text-gray-300 mt-0.5">{m.content?.slice(0, 200)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
