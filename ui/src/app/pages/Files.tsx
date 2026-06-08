/**
 * Assets (route /files) — reference + generated assets, grouped by project.
 * Full Projects/Assets spine lands in Phase 2; this is the rebuilt, themed view.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, FolderPlus, File as FileIcon, Plus } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/api-client";
import { apiFetch } from "../api";
import { fileUrl } from "../lib/useChatThread";
import { PageHeader, Card, Btn, Loading, EmptyState, Pill } from "../components/kit";

interface AssetFile { id: string; kind: string; filename: string; path: string; mimeType?: string }
interface Project { slug: string; name: string; description?: string; files?: AssetFile[] }

export function Files() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["file-projects"], queryFn: () => api.get<{ projects?: Project[] }>("/api/file-projects").then((d) => d.projects ?? (d as unknown as Project[]) ?? []) });
  const list = Array.isArray(projects.data) ? projects.data : [];
  const [active, setActive] = useState<string | null>(null);
  const [name, setName] = useState("");
  const current = list.find((p) => p.slug === active) ?? list[0];

  const create = async () => { if (!name.trim()) return; try { await apiFetch("/api/file-projects", { method: "POST", body: JSON.stringify({ name }) }); setName(""); qc.invalidateQueries({ queryKey: ["file-projects"] }); toast.success("Project created"); } catch { toast.error("Failed"); } };

  return (
    <div>
      <PageHeader title="Assets" description="Reference and generated assets, grouped by project." icon={ImageIcon} />
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        <Card className="p-3 h-fit">
          <div className="flex gap-2 mb-3">
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder="New project…" className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-900/60 border border-slate-700/60 rounded-lg text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
            <Btn onClick={() => void create()}><Plus className="w-4 h-4" /></Btn>
          </div>
          {projects.isLoading ? <Loading /> : list.length > 0 ? (
            <div className="space-y-1">
              {list.map((p) => (
                <button key={p.slug} onClick={() => setActive(p.slug)} className={`w-full text-left px-2.5 py-2 rounded-lg text-sm transition-colors ${(current?.slug === p.slug) ? "bg-[#00d9ff]/10 text-[#00d9ff]" : "text-gray-300 hover:bg-slate-800/50"}`}>
                  <div className="truncate">{p.name}</div>
                  <div className="text-[10px] text-gray-500">{p.files?.length ?? 0} files</div>
                </button>
              ))}
            </div>
          ) : <p className="text-xs text-gray-500 px-1 py-2">No projects yet.</p>}
        </Card>

        <div>
          {!current ? <EmptyState icon={FolderPlus} title="No project selected" hint="Create or pick a project to see its assets." /> : (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div><h2 className="text-sm font-semibold text-gray-100">{current.name}</h2>{current.description && <p className="text-xs text-gray-500">{current.description}</p>}</div>
                <Pill>{current.files?.length ?? 0} assets</Pill>
              </div>
              {current.files && current.files.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {current.files.map((f) => (
                    <a key={f.id} href={fileUrl(f.path)} target="_blank" rel="noreferrer" className="group rounded-lg border border-slate-800/60 overflow-hidden hover:border-[#00d9ff]/40 transition-colors">
                      {f.kind === "image"
                        ? <img src={fileUrl(f.path)} alt={f.filename} className="w-full h-28 object-cover" />
                        : <div className="w-full h-28 flex items-center justify-center bg-slate-900/40 text-gray-500"><FileIcon className="w-7 h-7" /></div>}
                      <div className="px-2 py-1.5 text-[11px] text-gray-400 truncate">{f.filename}</div>
                    </a>
                  ))}
                </div>
              ) : <EmptyState icon={ImageIcon} title="No assets yet" hint="Files the agent generates or you upload for this project show here." />}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
