import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ScrollText, Clock } from "lucide-react";

import { api } from "../lib/api-client";
import { PageHeader, Card, Loading, EmptyState, Pill } from "../components/kit";

interface TaskRow { id: string; input?: string; status?: string; createdAt?: string; type?: string }

export function Logs() {
  const tasks = useQuery({ queryKey: ["tasks-all"], queryFn: () => api.get<{ entries?: TaskRow[]; tasks?: TaskRow[] }>("/api/tasks?limit=100").then((d) => d.entries ?? d.tasks ?? []), refetchInterval: 10000 });
  const list = Array.isArray(tasks.data) ? tasks.data : [];
  return (
    <div>
      <PageHeader title="Logs" description="Every task the agent has run." icon={ScrollText} />
      {tasks.isLoading ? <Loading /> : list.length > 0 ? (
        <Card className="divide-y divide-slate-800/60">
          {list.map((t) => (
            <Link key={t.id} to={`/logs/${t.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/30 transition-colors">
              <Clock className="w-3.5 h-3.5 text-gray-500 shrink-0" />
              <span className="flex-1 truncate text-sm text-gray-300">{t.input || t.id}</span>
              {t.createdAt && <span className="text-xs text-gray-600 hidden sm:inline">{new Date(t.createdAt).toLocaleString()}</span>}
              <Pill tone={t.status === "completed" ? "ok" : t.status === "failed" ? "warn" : "default"}>{t.status ?? "—"}</Pill>
            </Link>
          ))}
        </Card>
      ) : <EmptyState icon={ScrollText} title="No tasks yet" hint="Run something in Chat and it'll appear here." />}
    </div>
  );
}
