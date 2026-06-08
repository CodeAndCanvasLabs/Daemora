import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Loading, EmptyState, Pill } from "../components/kit";

interface Profile { id: string; name: string; description?: string; role?: string; tagline?: string }

export function Agents() {
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api.get<{ active: string; profiles: Profile[] }>("/api/profiles") });
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => { if (profiles.data?.active) setActive(profiles.data.active); }, [profiles.data?.active]);

  const pick = async (id: string) => {
    setActive(id);
    try { await apiFetch("/api/profiles/active", { method: "POST", body: JSON.stringify({ id }) }); toast.success("Active agent switched"); }
    catch { toast.error("Failed to switch"); }
  };

  const list = profiles.data?.profiles ?? [];

  return (
    <div>
      <PageHeader title="Agents" description="Your AI workforce — specialist agents you can switch between. The active one runs your chats and channel messages." icon={Bot} />
      {profiles.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((p) => (
            <Card key={p.id} className={`p-4 ${active === p.id ? "border-[#00d9ff]/50" : ""}`} onClick={() => void pick(p.id)}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-[#4ECDC4]/15 text-[#4ECDC4] flex items-center justify-center"><Bot className="w-4 h-4" /></div>
                  <span className="text-sm font-medium text-gray-100">{p.name}</span>
                </div>
                {active === p.id && <Pill tone="ok">Active</Pill>}
              </div>
              {(p.tagline || p.description) && <p className="text-xs text-gray-400 mt-2 line-clamp-3">{p.tagline || p.description}</p>}
              <div className="text-[10px] text-gray-600 mt-2 font-mono">{p.id}</div>
            </Card>
          ))}
        </div>
      ) : <EmptyState icon={Bot} title="No agents found" hint="Specialist agent profiles will appear here." />}
    </div>
  );
}
