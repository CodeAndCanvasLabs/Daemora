import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flame, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Loading, EmptyState } from "../components/kit";

interface Skill { name: string; description?: string; triggers?: string[]; source?: string }

export function Skills() {
  const [q, setQ] = useState("");
  const [reloading, setReloading] = useState(false);
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api.get<{ skills?: Skill[] }>("/api/skills").then((d) => d.skills ?? (d as unknown as Skill[]) ?? []) });
  const list = useMemo(() => {
    const arr = Array.isArray(skills.data) ? skills.data : [];
    const t = q.toLowerCase();
    return t ? arr.filter((s) => s.name?.toLowerCase().includes(t) || s.description?.toLowerCase().includes(t)) : arr;
  }, [skills.data, q]);

  const reload = async () => { setReloading(true); try { await apiFetch("/api/skills/reload", { method: "POST" }); toast.success("Skills reloaded"); skills.refetch(); } catch { toast.error("Reload failed"); } finally { setReloading(false); } };

  return (
    <div>
      <PageHeader title="Skills" description="Reusable capabilities the agent can apply." icon={Flame}
        actions={<Btn variant="ghost" onClick={() => void reload()} disabled={reloading}><RefreshCw className={`w-4 h-4 ${reloading ? "animate-spin" : ""}`} /> Reload</Btn>} />
      <div className="relative max-w-sm mb-4">
        <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills…" className="w-full pl-9 pr-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
      </div>
      {skills.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.map((s) => (
            <Card key={s.name} className="p-4">
              <div className="text-sm font-medium text-gray-100">{s.name}</div>
              {s.description && <div className="text-xs text-gray-400 mt-1 line-clamp-3">{s.description}</div>}
              {s.triggers && s.triggers.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{s.triggers.slice(0, 4).map((t) => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-gray-400">{t}</span>)}</div>}
            </Card>
          ))}
        </div>
      ) : <EmptyState icon={Flame} title="No skills found" hint={q ? "Try a different search." : "Skills load from the bundled + custom skill packs."} />}
    </div>
  );
}
