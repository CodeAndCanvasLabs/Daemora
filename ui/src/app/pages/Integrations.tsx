import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Loading, EmptyState, Pill } from "../components/kit";

interface Account { accountId?: string; id?: string; label?: string; name?: string; integration?: string }
interface Integration { id: string; available: boolean; reason?: string; accounts: Account[] }
interface IntegrationsResponse {
  availability?: Record<string, { available: boolean; reason?: string }>;
  accounts?: Account[];
}

export function Integrations() {
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ["integrations"],
    queryFn: async (): Promise<Integration[]> => {
      const d = await api.get<IntegrationsResponse>("/api/integrations");
      const avail = d.availability ?? {};
      const accounts = d.accounts ?? [];
      return Object.entries(avail).map(([id, v]) => ({
        id,
        available: v.available,
        reason: v.reason,
        accounts: accounts.filter((a) => (a.integration ?? "") === id),
      }));
    },
  });
  const list = data.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations"] });

  const connect = async (id: string) => {
    try {
      const r = await apiFetch(`/api/integrations/${id}/start`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (d?.url) window.open(d.url, "_blank", "noopener");
      else { toast.success("Connection started"); refresh(); }
    } catch { toast.error("Couldn't start connection"); }
  };
  const disconnect = async (id: string, accountId: string) => {
    try { await apiFetch(`/api/integrations/${id}/${encodeURIComponent(accountId)}`, { method: "DELETE" }); refresh(); toast.success("Disconnected"); }
    catch { toast.error("Failed"); }
  };

  return (
    <div>
      <PageHeader title="Integrations" description="Connect third-party accounts the agent can act on (lazy — loaded only when used)." icon={Plug} />
      {data.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((it) => {
            const accounts = it.accounts ?? [];
            const connected = accounts.length > 0;
            return (
              <Card key={it.id} className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-100 capitalize">{it.id}</span>
                  <Pill tone={connected ? "ok" : it.available ? "off" : "warn"}>{connected ? "Connected" : it.available ? "Ready" : "Setup needed"}</Pill>
                </div>
                {!it.available && it.reason && <div className="text-xs text-[#ffaa00] mt-1">{it.reason}</div>}
                {accounts.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {accounts.map((a) => {
                      const aid = a.accountId || a.id || "";
                      return (
                        <div key={aid} className="flex items-center justify-between text-xs text-gray-400">
                          <span className="truncate">{a.label || a.name || aid}</span>
                          <button onClick={() => void disconnect(it.id, aid)} className="text-gray-500 hover:text-red-400"><Unlink className="w-3.5 h-3.5" /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3"><Btn variant="ghost" onClick={() => void connect(it.id)} disabled={!it.available}><Link2 className="w-4 h-4" /> {connected ? "Add account" : "Connect"}</Btn></div>
              </Card>
            );
          })}
        </div>
      ) : <EmptyState icon={Plug} title="No integrations available" hint="Integrations appear here once configured." />}
    </div>
  );
}
