/**
 * Projects — the sealed-workspace spine. Full project lifecycle:
 *   - create / rename / change type / delete a project
 *   - per-project tabs: Files (VS Code explorer w/ upload, drag-drop, paste,
 *     new file, move, delete), Chat (proj-<slug> session), Preview (live).
 * Each project is isolated to its `projects/<slug>/` folder; `type` (coding /
 * research / video / …) drives the agent's working style.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FolderKanban, ArrowLeft, Image as ImageIcon, FileText, Film, Music, Code, File as FileIcon,
  Bot, Download, Loader2, ChevronRight, Folder, FolderOpen, FileJson, FileCode2,
  MessageSquare, Monitor, FolderTree, FilePlus, FolderPlus, Upload, Trash2, Plus, Pencil, X,
  Code2, FlaskConical, Palette, PenLine, Database, Sparkles,
} from "lucide-react";

import { api } from "../lib/api-client";
import { fileUrl } from "../lib/useChatThread";
import { apiFetch } from "../api";
import { PageHeader, Card, Loading, EmptyState, Pill, Btn } from "../components/kit";
import { ChatThread } from "./chat/ChatThread";

type ProjectKind = "general" | "coding" | "research" | "video" | "design" | "writing" | "data";
interface Project { slug: string; name: string; kind: ProjectKind; description?: string; agent?: string; assetCount: number; updatedAt: number }
interface TreeNode { name: string; path: string; rel: string; type: "dir" | "file"; kind?: string; size?: number; children?: TreeNode[] }

const KIND_META: Record<ProjectKind, { label: string; icon: typeof Code2 }> = {
  general: { label: "General", icon: Sparkles },
  coding: { label: "Coding", icon: Code2 },
  research: { label: "Research", icon: FlaskConical },
  video: { label: "Video", icon: Film },
  design: { label: "Design", icon: Palette },
  writing: { label: "Writing", icon: PenLine },
  data: { label: "Data", icon: Database },
};
const KINDS = Object.keys(KIND_META) as ProjectKind[];

export function Projects() {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  if (openSlug) return <ProjectView slug={openSlug} onBack={() => setOpenSlug(null)} />;
  return <ProjectList onOpen={setOpenSlug} />;
}

function ProjectList({ onOpen }: { onOpen: (slug: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["projects"], queryFn: () => api.get<{ projects: Project[] }>("/api/projects").then((d) => d.projects ?? []) });
  const list = q.data ?? [];
  const [creating, setCreating] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["projects"] });

  return (
    <div>
      <PageHeader title="Projects" description="Each project is a sealed workspace — its own files, agent and live preview, isolated to its folder."
        icon={FolderKanban} actions={<Btn onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New Project</Btn>} />
      {q.isLoading ? <Loading /> : list.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {list.map((p) => {
            const meta = KIND_META[p.kind] ?? KIND_META.general;
            const Icon = meta.icon;
            return (
              <Card key={p.slug} className="p-4" onClick={() => onOpen(p.slug)}>
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-lg bg-[#00d9ff]/10 border border-[#00d9ff]/30 flex items-center justify-center"><Icon className="w-4 h-4 text-[#00d9ff]" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-100 truncate">{p.name}</div>
                    <div className="text-[10px] text-gray-500">{p.assetCount} files</div>
                  </div>
                  <Pill>{meta.label}</Pill>
                </div>
                {p.description && <p className="text-xs text-gray-400 mt-2 line-clamp-2">{p.description}</p>}
                {p.agent && <div className="mt-3 flex items-center gap-1 text-[11px] text-gray-500"><Bot className="w-3.5 h-3.5" /> {p.agent}</div>}
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={FolderKanban} title="No projects yet"
          hint="Create a project (coding, research, video, …) — or just start a generic Chat and ask the agent to build something; it organizes its work into a project here."
          action={<Btn onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New Project</Btn>} />
      )}
      <AnimatePresence>
        {creating && <ProjectFormModal title="New Project" submitLabel="Create"
          onClose={() => setCreating(false)}
          onSubmit={async (vals) => { const r = await api.post<{ project: Project }>("/api/projects", vals); await refresh(); setCreating(false); onOpen(r.project.slug); }} />}
      </AnimatePresence>
    </div>
  );
}

function ProjectView({ slug, onBack }: { slug: string; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["project", slug], queryFn: () => api.get<Project>(`/api/projects/${encodeURIComponent(slug)}`) });
  const p = q.data;
  const [tab, setTab] = useState<"files" | "chat" | "preview">("files");
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const meta = p ? (KIND_META[p.kind] ?? KIND_META.general) : KIND_META.general;

  return (
    <div>
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-[#00d9ff] mb-4"><ArrowLeft className="w-4 h-4" /> Projects</button>
      {q.isLoading ? <Loading /> : !p ? <p className="text-sm text-gray-400">Project not found.</p> : (
        <div>
          <PageHeader title={p.name} description={p.description} icon={meta.icon}
            actions={<div className="flex items-center gap-2">
              <Pill>{meta.label}</Pill>
              {p.agent && <Pill>{p.agent}</Pill>}
              <Btn variant="ghost" onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" /> Edit</Btn>
              <Btn variant="danger" onClick={() => setConfirmDel(true)}><Trash2 className="w-3.5 h-3.5" /> Delete</Btn>
            </div>} />

          <div className="flex flex-wrap gap-1 mb-4">
            {([["files", "Files", FolderTree], ["chat", "Chat", MessageSquare], ["preview", "Preview", Monitor]] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${tab === id ? "bg-[#00d9ff]/10 text-[#00d9ff] border border-[#00d9ff]/30" : "text-gray-400 hover:text-gray-200 border border-transparent"}`}>
                <Icon className="w-4 h-4" />{label}
              </button>
            ))}
          </div>

          {tab === "files" ? <FileExplorer slug={slug} />
            : tab === "preview" ? (
              <iframe title={`${p.name} preview`} src={`/_preview/${encodeURIComponent(slug)}/`}
                className="w-full h-[72vh] rounded-xl border border-slate-800/60 bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            ) : (
              <div className="h-[72vh] rounded-xl border border-slate-800/60 overflow-hidden bg-slate-900/20">
                <ChatThread sessionId={`proj-${slug}`} />
              </div>
            )}
        </div>
      )}
      <AnimatePresence>
        {editing && p && <ProjectFormModal title="Edit Project" submitLabel="Save" initial={p}
          onClose={() => setEditing(false)}
          onSubmit={async (vals) => { await api.patch(`/api/projects/${encodeURIComponent(slug)}`, vals); await qc.invalidateQueries({ queryKey: ["project", slug] }); setEditing(false); }} />}
        {confirmDel && <ConfirmModal title="Delete project?" body={`This permanently deletes "${p?.name}" and all its files.`} danger
          onClose={() => setConfirmDel(false)}
          onConfirm={async () => { await api.del(`/api/projects/${encodeURIComponent(slug)}`); await qc.invalidateQueries({ queryKey: ["projects"] }); setConfirmDel(false); onBack(); }} />}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────── modals ───────────────────────────

function Modal({ title, onClose, children, maxW = "max-w-md" }: { title: string; onClose: () => void; children: React.ReactNode; maxW?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div className="absolute inset-0 bg-black/70" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
        className={`relative w-full ${maxW} rounded-2xl border border-slate-700/60 bg-slate-900 overflow-hidden`}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-slate-800/60">
          <span className="text-sm font-semibold text-gray-100">{title}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4">{children}</div>
      </motion.div>
    </div>
  );
}

function ProjectFormModal({ title, submitLabel, initial, onClose, onSubmit }: {
  title: string; submitLabel: string; initial?: Project; onClose: () => void;
  onSubmit: (vals: { name: string; kind: ProjectKind; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<ProjectKind>(initial?.kind ?? "general");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) { setErr("Name is required"); return; }
    setBusy(true); setErr(null);
    try { await onSubmit({ name: name.trim(), kind, description: description.trim() }); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-[11px] text-gray-400 uppercase tracking-wide">Name</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder="My project" className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50" />
        </div>
        <div>
          <label className="text-[11px] text-gray-400 uppercase tracking-wide">Type</label>
          <div className="mt-1 grid grid-cols-4 gap-1.5">
            {KINDS.map((k) => {
              const M = KIND_META[k]; const Icon = M.icon; const on = kind === k;
              return (
                <button key={k} onClick={() => setKind(k)}
                  className={`flex flex-col items-center gap-1 py-2 rounded-lg border text-[11px] transition-colors ${on ? "border-[#00d9ff]/50 bg-[#00d9ff]/10 text-[#00d9ff]" : "border-slate-700 text-gray-400 hover:text-gray-200"}`}>
                  <Icon className="w-4 h-4" />{M.label}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="text-[11px] text-gray-400 uppercase tracking-wide">Description <span className="text-gray-600">(optional)</span></label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
            placeholder="What this project is for…" className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-100 outline-none focus:border-[#00d9ff]/50 resize-none" />
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : submitLabel}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ConfirmModal({ title, body, danger, onClose, onConfirm }: { title: string; body: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-gray-300">{body}</p>
      <div className="flex justify-end gap-2 mt-4">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant={danger ? "danger" : "primary"} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{busy ? "Working…" : "Confirm"}</Btn>
      </div>
    </Modal>
  );
}

// ─────────────────────────── VS Code-style file explorer ───────────────────────────

function fileIcon(name: string, kind?: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "image" || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return ImageIcon;
  if (kind === "video" || ["mp4", "mov", "webm"].includes(ext)) return Film;
  if (kind === "audio" || ["mp3", "wav", "m4a", "ogg"].includes(ext)) return Music;
  if (["json"].includes(ext)) return FileJson;
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "rb", "php", "sh", "css", "html"].includes(ext)) return FileCode2;
  if (["md", "txt", "pdf", "csv", "log", "yml", "yaml"].includes(ext)) return FileText;
  return FileIcon;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function FileExplorer({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["project-tree", slug], queryFn: () => api.get<{ tree: TreeNode[] }>(`/api/projects/${encodeURIComponent(slug)}/tree`).then((d) => d.tree ?? []) });
  const tree = q.data ?? [];
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [creating, setCreating] = useState<null | "file" | "folder">(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const firstFile = useMemo(() => findFirstFile(tree), [tree]);
  useEffect(() => { if (!selected && firstFile) setSelected(firstFile); }, [firstFile, selected]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["project-tree", slug] });
  const fail = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4000); };

  async function uploadFiles(files: FileList | File[], dir = "") {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setBusy(`Uploading ${arr.length} file${arr.length > 1 ? "s" : ""}…`);
    try {
      const payload = await Promise.all(arr.map(async (f) => ({ name: f.name, base64: await fileToBase64(f) })));
      await api.post(`/api/projects/${encodeURIComponent(slug)}/upload`, { dir, files: payload });
      await refresh();
    } catch (e) { fail(`Upload failed: ${(e as Error).message}`); } finally { setBusy(null); }
  }

  async function createEntry() {
    const kind = creating;
    let name = newName.trim();
    setCreating(null); setNewName("");
    if (!name || !kind) return;
    if (kind === "folder" && !name.endsWith("/")) name += "/";   // trailing slash = folder
    setBusy("Creating…");
    try { await api.post(`/api/projects/${encodeURIComponent(slug)}/file`, { path: name }); await refresh(); }
    catch (e) { fail(`Create failed: ${(e as Error).message}`); } finally { setBusy(null); }
  }

  async function moveEntry(from: string, toDir: string) {
    const base = from.split("/").pop()!;
    const to = toDir ? `${toDir}/${base}` : base;
    if (to === from) return;
    setBusy("Moving…");
    try { await api.post(`/api/projects/${encodeURIComponent(slug)}/move`, { from, to }); await refresh(); }
    catch (e) { fail(`Move failed: ${(e as Error).message}`); } finally { setBusy(null); }
  }

  async function doDelete(rel: string) {
    setPendingDelete(null);
    setBusy("Deleting…");
    try {
      await api.del(`/api/projects/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(rel)}`);
      if (selected?.rel === rel) setSelected(null);
      await refresh();
    } catch (e) { fail(`Delete failed: ${(e as Error).message}`); } finally { setBusy(null); }
  }

  return (
    <div
      className={`relative grid grid-cols-1 md:grid-cols-[minmax(220px,300px)_1fr] gap-0 rounded-xl border overflow-hidden h-[72vh] bg-[#0b1120] transition-colors ${dragOver ? "border-[#00d9ff]/70 ring-1 ring-[#00d9ff]/40" : "border-slate-800/60"}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files); } }}
      onPaste={(e) => { const fs = e.clipboardData?.files; if (fs?.length) { e.preventDefault(); void uploadFiles(fs); } }}
      tabIndex={0}
    >
      {/* tree pane */}
      <div className="border-b md:border-b-0 md:border-r border-slate-800/60 overflow-auto bg-[#0a0f1a] max-h-[30vh] md:max-h-none"
        onDrop={(e) => { const from = e.dataTransfer.getData("application/x-daemora-path"); if (from) { e.preventDefault(); void moveEntry(from, ""); } }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-daemora-path")) e.preventDefault(); }}>
        <div className="px-3 h-9 flex items-center justify-between text-[11px] uppercase tracking-wide text-gray-500 border-b border-slate-800/40 sticky top-0 bg-[#0a0f1a] z-10">
          <span>Explorer</span>
          <span className="flex items-center gap-1 normal-case">
            <button title="New file" onClick={() => { setCreating("file"); setNewName(""); }} className="p-1 rounded hover:bg-white/10 hover:text-[#00d9ff]"><FilePlus className="w-3.5 h-3.5" /></button>
            <button title="New folder" onClick={() => { setCreating("folder"); setNewName(""); }} className="p-1 rounded hover:bg-white/10 hover:text-[#00d9ff]"><FolderPlus className="w-3.5 h-3.5" /></button>
            <button title="Upload files" onClick={() => fileInput.current?.click()} className="p-1 rounded hover:bg-white/10 hover:text-[#00d9ff]"><Upload className="w-3.5 h-3.5" /></button>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ""; }} />
          </span>
        </div>
        {creating && (
          <div className="px-2 py-1 flex items-center gap-1.5">
            {creating === "folder" ? <FolderPlus className="w-3.5 h-3.5 text-[#5eb3f6] shrink-0" /> : <FilePlus className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createEntry(); if (e.key === "Escape") { setCreating(null); setNewName(""); } }}
              onBlur={() => void createEntry()} placeholder={creating === "folder" ? "folder name" : "name.ext"}
              className="w-full bg-slate-900 border border-[#00d9ff]/40 rounded px-2 py-1 text-[12px] text-gray-100 outline-none" />
          </div>
        )}
        {q.isLoading ? <div className="p-4"><Loader2 className="w-4 h-4 animate-spin text-[#00d9ff]" /></div>
          : tree.length === 0 ? <div className="p-4 text-xs text-gray-500 leading-relaxed">Empty. Use the <FilePlus className="inline w-3 h-3" /> / <Upload className="inline w-3 h-3" /> buttons, or drag &amp; drop / paste files here.</div>
          : <div className="py-1">{tree.map((n) => <TreeRow key={n.path} node={n} depth={0} selected={selected} onSelect={setSelected} onMove={moveEntry} onUploadTo={uploadFiles} onDelete={setPendingDelete} />)}</div>}
      </div>
      {/* content pane */}
      <div className="overflow-auto bg-[#0b1120] min-h-0 relative">
        {busy && <div className="absolute top-2 right-3 z-20 text-[11px] text-[#00d9ff] flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />{busy}</div>}
        {selected ? (
          <div className="flex flex-col h-full">
            <div className="px-4 h-9 flex items-center justify-between border-b border-slate-800/40 sticky top-0 bg-[#0b1120] z-10">
              <span className="text-xs text-gray-300 font-mono truncate">{selected.rel}</span>
              <a href={fileUrl(selected.path)} download={selected.name} className="text-gray-500 hover:text-[#00d9ff]" title="Download"><Download className="w-3.5 h-3.5" /></a>
            </div>
            <div className="flex-1 overflow-auto p-4"><FileBody kind={selected.kind ?? "file"} filename={selected.name} path={selected.path} /></div>
          </div>
        ) : <div className="h-full flex items-center justify-center text-sm text-gray-600">Select a file to view it.</div>}
      </div>

      {/* themed toast + delete confirm (no browser dialogs) */}
      <AnimatePresence>
        {toast && <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/40 text-xs text-red-300">{toast}</motion.div>}
        {pendingDelete && <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-gray-200">
          <span>Delete <span className="font-mono text-gray-100">{pendingDelete}</span>?</span>
          <button onClick={() => void doDelete(pendingDelete)} className="text-red-400 hover:text-red-300 font-medium">Delete</button>
          <button onClick={() => setPendingDelete(null)} className="text-gray-400 hover:text-white">Cancel</button>
        </motion.div>}
      </AnimatePresence>
    </div>
  );
}

function findFirstFile(nodes: TreeNode[]): TreeNode | null {
  const flat: TreeNode[] = [];
  const walk = (ns: TreeNode[]) => { for (const n of ns) { if (n.type === "file") flat.push(n); else if (n.children) walk(n.children); } };
  walk(nodes);
  return flat.find((f) => /^(readme|index)\./i.test(f.name)) ?? flat[0] ?? null;
}

function TreeRow({ node, depth, selected, onSelect, onMove, onUploadTo, onDelete }: {
  node: TreeNode; depth: number; selected: TreeNode | null;
  onSelect: (n: TreeNode) => void; onMove: (from: string, toDir: string) => void;
  onUploadTo: (files: FileList, dir: string) => void; onDelete: (rel: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const [dropHot, setDropHot] = useState(false);
  const pad = { paddingLeft: `${8 + depth * 12}px` };
  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("application/x-daemora-path", node.rel); e.dataTransfer.effectAllowed = "move"; },
  };

  if (node.type === "dir") {
    const FolderIcon = open ? FolderOpen : Folder;
    return (
      <div>
        <button {...dragProps} onClick={() => setOpen((o) => !o)} style={pad}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-daemora-path") || e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropHot(true); } }}
          onDragLeave={() => setDropHot(false)}
          onDrop={(e) => {
            e.preventDefault(); e.stopPropagation(); setDropHot(false);
            const from = e.dataTransfer.getData("application/x-daemora-path");
            if (from && from !== node.rel) onMove(from, node.rel);
            else if (e.dataTransfer.files?.length) onUploadTo(e.dataTransfer.files, node.rel);
          }}
          className={`group w-full flex items-center gap-1 pr-2 py-1 text-[13px] text-gray-300 transition-colors ${dropHot ? "bg-[#00d9ff]/15" : "hover:bg-white/5"}`}>
          <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-gray-500 transition-transform ${open ? "rotate-90" : ""}`} />
          <FolderIcon className="w-4 h-4 shrink-0 text-[#5eb3f6]" />
          <span className="truncate flex-1 text-left">{node.name}</span>
          <Trash2 onClick={(e) => { e.stopPropagation(); onDelete(node.rel); }} className="w-3.5 h-3.5 shrink-0 text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400" />
        </button>
        <AnimatePresence initial={false}>
          {open && node.children && node.children.length > 0 && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.12 }} className="overflow-hidden">
              {node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} onMove={onMove} onUploadTo={onUploadTo} onDelete={onDelete} />)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }
  const Icon = fileIcon(node.name, node.kind);
  const active = selected?.path === node.path;
  return (
    <button {...dragProps} onClick={() => onSelect(node)} style={pad}
      className={`group w-full flex items-center gap-1.5 pr-2 py-1 text-[13px] transition-colors ${active ? "bg-[#00d9ff]/10 text-[#00d9ff]" : "text-gray-400 hover:bg-white/5"}`}>
      <span className="w-3.5 shrink-0" />
      <Icon className={`w-4 h-4 shrink-0 ${active ? "text-[#00d9ff]" : "text-gray-500"}`} />
      <span className="truncate flex-1 text-left">{node.name}</span>
      <Trash2 onClick={(e) => { e.stopPropagation(); onDelete(node.rel); }} className="w-3.5 h-3.5 shrink-0 text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400" />
    </button>
  );
}

// ─────────────────────────── file body renderer ───────────────────────────

function FileBody({ kind, filename, path }: { kind: string; filename: string; path: string }) {
  const url = fileUrl(path);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md";
  const isPdf = ext === "pdf";
  const isCode = kind === "code" || ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "rb", "php", "sh", "css", "html", "json", "yml", "yaml"].includes(ext);
  const isText = kind === "document" || isCode || ["md", "txt", "csv", "log"].includes(ext);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isText || isPdf) { setText(null); return; }
    setLoading(true);
    apiFetch(url).then((r) => r.text()).then(setText).catch(() => setText("(couldn't load file)")).finally(() => setLoading(false));
  }, [url, isText, isPdf]);

  if (kind === "image") return <div className="flex items-center justify-center"><img src={url} alt={filename} className="max-w-full max-h-[68vh] object-contain rounded" /></div>;
  if (kind === "video") return <div className="flex items-center justify-center"><video src={url} controls className="max-w-full max-h-[68vh] rounded" /></div>;
  if (kind === "audio") return <audio src={url} controls className="w-full" />;
  if (isPdf) return <iframe src={url} title={filename} className="w-full h-[68vh] bg-white rounded" />;
  if (loading) return <Loader2 className="w-5 h-5 animate-spin text-[#00d9ff]" />;
  if (isMd) return <div className="prose prose-invert prose-sm max-w-none break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text ?? ""}</ReactMarkdown></div>;
  if (isText) return <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words font-mono leading-relaxed">{text}</pre>;
  return <a href={url} download={filename} className="inline-flex items-center gap-2 text-[#00d9ff] hover:underline"><Download className="w-4 h-4" /> Download {filename}</a>;
}
