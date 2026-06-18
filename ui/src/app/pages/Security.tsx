import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { api } from "../lib/api-client";
import { PageHeader, Card, Loading, Pill } from "../components/kit";

interface AuditRow { id?: string | number; action?: string; kind?: string; actor?: string; risk?: string; created_at?: string; at?: string }

export function Security() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ entries?: AuditRow[] }>("/api/audit").then((d) => d.entries ?? (d as unknown as AuditRow[]) ?? []) });
  const rows = Array.isArray(audit.data) ? audit.data : [];

  return (
    <div>
      <PageHeader title="Security" description="Your workspace is automatically sandboxed. Below is the audit trail of sensitive actions." icon={ShieldAlert} />

      <Card className="p-4 mb-4 flex items-start gap-3 border-[#00ff88]/20">
        <div className="w-9 h-9 rounded-lg bg-[#00ff88]/10 border border-[#00ff88]/30 flex items-center justify-center shrink-0"><ShieldCheck className="w-5 h-5 text-[#00ff88]" /></div>
        <div>
          <div className="text-sm font-medium text-gray-100">Sandboxed workspace</div>
          <p className="text-xs text-gray-400 mt-0.5 max-w-2xl">Your agents have full freedom inside your workspace (all tools and crews on your plan) but can never read or write outside it. This boundary is enforced by the platform and can't be changed.</p>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-gray-200 mb-3">Audit log</h2>
        {audit.isLoading ? <Loading /> : rows.length > 0 ? (
          <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
            {rows.slice(0, 100).map((a, i) => (
              <div key={a.id ?? i} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-800/50">
                <span className="flex-1 text-gray-300 truncate">{a.action || a.kind || "event"}</span>
                {a.risk && <Pill tone={a.risk === "high" ? "warn" : "default"}>{a.risk}</Pill>}
                <span className="text-gray-600">{(a.created_at || a.at) ? new Date(a.created_at || a.at!).toLocaleString() : ""}</span>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-gray-500">No audit entries.</p>}
      </Card>
    </div>
  );
}
