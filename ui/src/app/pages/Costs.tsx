import { useQuery } from "@tanstack/react-query";
import { Fingerprint } from "lucide-react";

import { api } from "../lib/api-client";
import { PageHeader, StatCard, Card, Loading, EmptyState } from "../components/kit";

interface DayCost { date?: string; day?: string; costUsd?: number; totalCostUsd?: number }

export function Costs() {
  const today = useQuery({ queryKey: ["costs-today"], queryFn: () => api.get<{ totalCostUsd?: number }>("/api/costs/today") });
  const breakdown = useQuery({ queryKey: ["costs-breakdown"], queryFn: () => api.get<{ breakdown?: DayCost[] }>("/api/costs/daily?days=14").then((d) => d.breakdown ?? []) });
  const usd = (n?: number) => `$${(n ?? 0).toFixed(4)}`;
  const days = breakdown.data ?? [];

  return (
    <div>
      <PageHeader title="Costs" description="Model spend on your own credits." icon={Fingerprint} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label="Today" value={usd(today.data?.totalCostUsd)} />
        <StatCard label="Last 14 days" value={usd(days.reduce((a, d) => a + (d.costUsd ?? d.totalCostUsd ?? 0), 0))} accent="#4ECDC4" />
      </div>
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-gray-200 mb-3">Daily breakdown</h2>
        {breakdown.isLoading ? <Loading /> : days.length > 0 ? (
          <div className="space-y-1.5">
            {days.map((d, i) => {
              const v = d.costUsd ?? d.totalCostUsd ?? 0;
              const max = Math.max(...days.map((x) => x.costUsd ?? x.totalCostUsd ?? 0), 0.0001);
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-gray-500 w-24 shrink-0">{d.date ?? d.day ?? "—"}</span>
                  <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden"><div className="h-full bg-gradient-to-r from-[#00d9ff] to-[#4ECDC4]" style={{ width: `${(v / max) * 100}%` }} /></div>
                  <span className="text-xs text-gray-400 w-20 text-right shrink-0">{usd(v)}</span>
                </div>
              );
            })}
          </div>
        ) : <EmptyState icon={Fingerprint} title="No spend recorded" hint="Costs appear once the agent runs model calls." />}
      </Card>
    </div>
  );
}
