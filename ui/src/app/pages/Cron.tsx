import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Timer, Plus, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Loading, EmptyState, Pill } from "../components/kit";

interface Schedule { kind?: string; expr?: string; tz?: string; everyMs?: number; at?: string }
interface Job { id: string; name?: string; schedule?: string | Schedule; expression?: string; cron?: string; prompt?: string; enabled?: boolean }

/** The schedule can be a cron string OR a structured object — render safely (never an object child). */
function scheduleLabel(j: Job): string {
  if (typeof j.expression === "string" && j.expression) return j.expression;
  const s = j.schedule;
  if (typeof s === "string") return s;
  if (s && typeof s === "object") return s.expr || (s.everyMs ? `every ${Math.round(s.everyMs / 1000)}s` : "") || s.at || s.kind || "scheduled";
  return j.cron || "—";
}

export function Cron() {
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ["cron-jobs"], queryFn: () => api.get<{ jobs?: Job[] }>("/api/cron/jobs").then((d) => d.jobs ?? (d as unknown as Job[]) ?? []) });
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const list = Array.isArray(jobs.data) ? jobs.data : [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["cron-jobs"] });

  const add = async () => { if (!name.trim() || !schedule.trim()) return; try { await apiFetch("/api/cron/jobs", { method: "POST", body: JSON.stringify({ name, expression: schedule, prompt }) }); setName(""); setSchedule(""); setPrompt(""); refresh(); toast.success("Job scheduled"); } catch { toast.error("Failed"); } };
  const run = async (id: string) => { try { await apiFetch(`/api/cron/jobs/${id}/run`, { method: "POST" }); toast.success("Run triggered"); } catch { toast.error("Failed"); } };
  const del = async (id: string) => { try { await apiFetch(`/api/cron/jobs/${id}`, { method: "DELETE" }); refresh(); } catch { toast.error("Failed"); } };

  return (
    <div>
      <PageHeader title="Scheduler" description="Recurring tasks the agent runs on a schedule." icon={Timer} />
      <Card className="p-3 mb-4 max-w-2xl space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Job name…" className="flex-1 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="cron e.g. 0 9 * * *" className="sm:w-48 px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm font-mono text-gray-100 outline-none focus:border-[#00d9ff]/50" />
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="What should it do?" className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
        <div className="flex justify-end"><Btn onClick={() => void add()}><Plus className="w-4 h-4" /> Schedule</Btn></div>
      </Card>
      {jobs.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="space-y-2 max-w-2xl">
          {list.map((j) => (
            <Card key={j.id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-100 truncate">{j.name || j.id}</div>
                <div className="text-xs text-gray-500 font-mono">{scheduleLabel(j)}</div>
              </div>
              <Pill tone={j.enabled === false ? "off" : "ok"}>{j.enabled === false ? "Paused" : "Active"}</Pill>
              <Btn variant="ghost" onClick={() => void run(j.id)}><Play className="w-4 h-4" /></Btn>
              <Btn variant="danger" onClick={() => void del(j.id)}><Trash2 className="w-4 h-4" /></Btn>
            </Card>
          ))}
        </div>
      ) : <EmptyState icon={Timer} title="No scheduled jobs" hint="Schedule a recurring task for the agent to run automatically." />}
    </div>
  );
}
