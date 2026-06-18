import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Cpu, Wrench, Clock, ScrollText } from "lucide-react";
import { Link } from "react-router";

import { api } from "../lib/api-client";
import { PageHeader, StatCard, Card, Loading, EmptyState, Pill } from "../components/kit";

interface Health { ok?: boolean; model?: string; tools?: number; uptime?: number; permissionTier?: string }
interface TaskRow { id: string; input?: string; status?: string; createdAt?: string }

export function Dashboard() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/api/health"), refetchInterval: 15000 });
  const tasks = useQuery({ queryKey: ["recent-tasks"], queryFn: () => api.get<{ entries?: TaskRow[]; tasks?: TaskRow[] }>("/api/tasks?limit=5&type=task").then((d) => d.entries ?? d.tasks ?? []) });
  const h = health.data;
  const fmtUptime = (s?: number) => (s ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : "—");

  return (
    <div>
      <PageHeader title="Overview" description="Your agent at a glance." icon={LayoutDashboard} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Model" value={<span className="text-base break-all">{h?.model ?? "—"}</span>} />
        <StatCard label="Tools" value={h?.tools ?? "—"} accent="#4ECDC4" />
        <StatCard label="Uptime" value={fmtUptime(h?.uptime)} accent="#7C6AFF" />
        <StatCard label="Tier" value={<span className="text-base capitalize">{h?.permissionTier ?? "—"}</span>} accent="#00ff88" />
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2"><ScrollText className="w-4 h-4 text-[#00d9ff]" /> Recent activity</h2>
          <Link to="/logs" className="text-xs text-[#00d9ff] hover:underline">View all</Link>
        </div>
        {tasks.isLoading ? <Loading /> : (tasks.data && tasks.data.length > 0 ? (
          <div className="divide-y divide-slate-800/60">
            {tasks.data.map((t) => (
              <Link key={t.id} to={`/logs/${t.id}`} className="flex items-center gap-3 py-2.5 hover:bg-slate-800/30 rounded px-2 -mx-2">
                <Clock className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                <span className="flex-1 truncate text-sm text-gray-300">{t.input || t.id}</span>
                <Pill tone={t.status === "completed" ? "ok" : t.status === "failed" ? "warn" : "default"}>{t.status ?? "—"}</Pill>
              </Link>
            ))}
          </div>
        ) : <EmptyState icon={Wrench} title="No activity yet" hint="Tasks the agent runs will show up here." />)}
      </Card>
    </div>
  );
}
