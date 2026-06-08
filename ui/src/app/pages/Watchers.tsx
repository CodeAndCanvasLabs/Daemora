import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { PageHeader, Card, Btn, Loading, EmptyState, Pill } from "../components/kit";

interface Watcher { id: string; name?: string; description?: string; prompt?: string; enabled?: boolean; trigger?: string }

export function Watchers() {
  const qc = useQueryClient();
  const watchers = useQuery({ queryKey: ["watchers"], queryFn: () => api.get<{ watchers?: Watcher[] }>("/api/watchers").then((d) => d.watchers ?? (d as unknown as Watcher[]) ?? []) });
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const list = Array.isArray(watchers.data) ? watchers.data : [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["watchers"] });

  const add = async () => { if (!name.trim()) return; try { await apiFetch("/api/watchers", { method: "POST", body: JSON.stringify({ name, prompt }) }); setName(""); setPrompt(""); refresh(); toast.success("Watcher added"); } catch { toast.error("Failed"); } };
  const del = async (id: string) => { try { await apiFetch(`/api/watchers/${id}`, { method: "DELETE" }); refresh(); } catch { toast.error("Failed"); } };

  return (
    <div>
      <PageHeader title="Watchers" description="Conditions the agent monitors, acting when they trigger." icon={Eye} />
      <Card className="p-3 mb-4 max-w-2xl space-y-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Watcher name…" className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="What should it watch for / do?" className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
        <div className="flex justify-end"><Btn onClick={() => void add()}><Plus className="w-4 h-4" /> Add watcher</Btn></div>
      </Card>
      {watchers.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="space-y-2 max-w-2xl">
          {list.map((w) => (
            <Card key={w.id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-100 truncate">{w.name || w.id}</div>
                {(w.description || w.prompt) && <div className="text-xs text-gray-500 truncate">{w.description || w.prompt}</div>}
              </div>
              <Pill tone={w.enabled === false ? "off" : "ok"}>{w.enabled === false ? "Off" : "On"}</Pill>
              <Btn variant="danger" onClick={() => void del(w.id)}><Trash2 className="w-4 h-4" /></Btn>
            </Card>
          ))}
        </div>
      ) : <EmptyState icon={Eye} title="No watchers" hint="Add a watcher to have the agent monitor something for you." />}
    </div>
  );
}
