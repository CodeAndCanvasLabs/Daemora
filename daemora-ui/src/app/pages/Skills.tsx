import { useEffect, useState } from "react";
import { Sparkles, RefreshCw, Calendar, Plus, Trash2, Loader2, Clock, Terminal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { toast } from "sonner";

interface Skill {
  name: string;
  description: string;
}

interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  taskInput: string;
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddScheduleOpen, setIsAddScheduleOpen] = useState(false);
  const [newSchedule, setNewSchedule] = useState({
    name: "",
    cronExpression: "",
    taskInput: "",
  });

  const fetchData = async () => {
    try {
      const [skillsRes, schedulesRes] = await Promise.all([
        fetch("/api/skills"),
        fetch("/api/schedules")
      ]);
      if (skillsRes.ok) {
        const data = await skillsRes.json();
        setSkills(data.skills || []);
      }
      if (schedulesRes.ok) {
        const data = await schedulesRes.json();
        setSchedules(data.schedules || []);
      }
    } catch (error) {
      console.error("Failed to fetch skills/schedules", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleReloadSkills = async () => {
    const toastId = toast.loading("Reloading skills...");
    try {
      const res = await fetch("/api/skills/reload", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
        toast.success("Skills reloaded", { id: toastId });
      }
    } catch (err) {
      toast.error("Failed to reload skills", { id: toastId });
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    try {
      const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Schedule deleted");
        fetchData();
      }
    } catch (err) {
      toast.error("Failed to delete schedule");
    }
  };

  const handleAddSchedule = async () => {
    if (!newSchedule.name || !newSchedule.cronExpression || !newSchedule.taskInput) return;
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSchedule),
      });
      if (res.ok) {
        toast.success("Schedule created");
        setIsAddScheduleOpen(false);
        setNewSchedule({ name: "", cronExpression: "", taskInput: "" });
        fetchData();
      } else {
        const err = await res.json();
        toast.error(err.error || "SCHEDULING ERROR");
      }
    } catch (err) {
      toast.error("API CONNECTION ERROR");
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
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Skills</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">AGENT SKILLS & SCHEDULES</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Skills Section */}
        <Card className="lg:col-span-2 bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl h-full">
          <CardHeader className="border-b border-slate-800/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Sparkles className="w-6 h-6 text-[#00d9ff]" />
                <div>
                  <CardTitle className="text-white uppercase tracking-tight">Loaded Skills</CardTitle>
                  <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                    AVAILABLE CAPABILITIES
                  </CardDescription>
                </div>
              </div>
              <Button
                onClick={handleReloadSkills}
                variant="ghost"
                size="sm"
                className="text-gray-400 hover:text-[#00d9ff] font-mono text-[10px] uppercase tracking-wider"
              >
                <RefreshCw className="w-3 h-3 mr-2" />
                Reload
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {skills.length === 0 ? (
                <div className="col-span-full text-center py-12 text-gray-600 font-mono uppercase text-xs">No skills detected in /skills directory</div>
              ) : (
                skills.map((skill) => (
                  <div
                    key={skill.name}
                    className="p-4 bg-slate-800/30 border border-slate-800 rounded-lg hover:border-[#00d9ff]/30 transition-colors group"
                  >
                    <div className="font-mono text-sm text-[#00d9ff] uppercase tracking-tighter mb-1 group-hover:text-white transition-colors">{skill.name}</div>
                    <p className="text-xs text-gray-500 font-mono leading-relaxed lowercase">{skill.description}</p>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Schedules Section */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl flex flex-col h-full">
          <CardHeader className="border-b border-slate-800/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Calendar className="w-6 h-6 text-[#7C6AFF]" />
                <div>
                  <CardTitle className="text-white uppercase tracking-tight">Schedules</CardTitle>
                  <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                    CRON-BASED TASKS
                  </CardDescription>
                </div>
              </div>
              <Dialog open={isAddScheduleOpen} onOpenChange={setIsAddScheduleOpen}>
                <DialogTrigger asChild>
                  <Button size="icon" variant="ghost" className="text-[#00d9ff] hover:bg-[#00d9ff]/10">
                    <Plus className="w-5 h-5" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-slate-950 border-slate-800 text-white font-mono">
                  <DialogHeader>
                    <DialogTitle className="uppercase tracking-widest text-sm border-b border-slate-800 pb-4">New Schedule</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 pt-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-gray-500 uppercase">Identifier</label>
                      <Input
                        value={newSchedule.name}
                        onChange={(e) => setNewSchedule({ ...newSchedule, name: e.target.value })}
                        placeholder="PROTOCOL_NAME"
                        className="bg-slate-900 border-slate-800 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-gray-500 uppercase">Cron Pattern</label>
                      <Input
                        value={newSchedule.cronExpression}
                        onChange={(e) => setNewSchedule({ ...newSchedule, cronExpression: e.target.value })}
                        placeholder="0 * * * *"
                        className="bg-slate-900 border-slate-800 text-xs text-[#00ff88]"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-gray-500 uppercase">Task Directive</label>
                      <Input
                        value={newSchedule.taskInput}
                        onChange={(e) => setNewSchedule({ ...newSchedule, taskInput: e.target.value })}
                        placeholder="Input for the agent..."
                        className="bg-slate-900 border-slate-800 text-xs"
                      />
                    </div>
                    <Button
                      onClick={handleAddSchedule}
                      className="w-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4] text-white uppercase text-xs tracking-tighter"
                    >
                      Create Schedule
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto pt-6 px-4">
            <div className="space-y-3">
              {schedules.length === 0 ? (
                <div className="text-center py-12 text-gray-700 font-mono uppercase text-[10px] tracking-widest">No schedules</div>
              ) : (
                schedules.map((schedule) => (
                  <div
                    key={schedule.id}
                    className="p-3 bg-slate-800/20 border border-slate-800/50 rounded-lg group relative"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Clock className="w-3 h-3 text-[#00ff88]" />
                          <div className="font-mono text-xs text-white uppercase truncate">{schedule.name}</div>
                        </div>
                        <Badge variant="outline" className="bg-slate-950/50 text-[#00ff88] border-[#00ff88]/20 font-mono text-[9px]">
                          {schedule.cronExpression}
                        </Badge>
                        <div className="text-[10px] text-gray-500 font-mono mt-2 truncate lowercase italic">
                          {schedule.taskInput}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteSchedule(schedule.id)}
                        className="text-gray-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
