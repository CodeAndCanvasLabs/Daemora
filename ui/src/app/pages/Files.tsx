import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Folder,
  FolderPlus,
  Image as ImageIcon,
  FileText,
  File as FileIcon,
  Trash2,
  Upload,
  Loader2,
  CheckCircle,
  AlertTriangle,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch, apiGet, apiJson } from "../api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

type FileKind = "image" | "pdf" | "document" | "audio" | "video" | "text" | "other";
type ScanStatus = "pending" | "scanning" | "completed" | "failed" | "skipped";

interface FileRecord {
  id: string;
  kind: FileKind;
  filename: string;
  path: string;
  mimeType: string;
  size: number;
  filerPath?: string;
  scanStatus?: ScanStatus;
  scanError?: string;
  createdAt: string;
}

interface FileProject {
  id: string;
  slug: string;
  name: string;
  color?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  files: FileRecord[];
}

interface ListResponse {
  projects: FileProject[];
}

interface ProviderModel {
  id: string;       // "provider:model"
  name: string;
}
interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  models: ProviderModel[];
}

const POLL_INTERVAL_MS = 3000;

export function Files() {
  const [projects, setProjects] = useState<FileProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [filerOpen, setFilerOpen] = useState<{ slug: string; fileId: string; markdown: string } | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<FileProject | null>(null);
  const [deleteFileTarget, setDeleteFileTarget] = useState<FileRecord | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [scanModel, setScanModel] = useState<string>(""); // "" = use main agent's model
  const [savingScanModel, setSavingScanModel] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<ListResponse>("/api/file-projects");
      setProjects(data.projects);
      if (!activeSlug && data.projects.length > 0) {
        setActiveSlug(data.projects[0]!.slug);
      }
    } catch (e) {
      toast.error(`Failed to load projects: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [activeSlug]);

  useEffect(() => { void load(); }, [load]);

  // One-shot fetch of provider catalog + the saved IMAGE_SCAN_MODEL.
  useEffect(() => {
    void (async () => {
      try {
        const [provRes, settingRes] = await Promise.all([
          apiGet<{ providers: ProviderInfo[] }>("/api/providers"),
          apiGet<{ value: string | null }>("/api/settings/IMAGE_SCAN_MODEL"),
        ]);
        setProviders(provRes.providers ?? []);
        setScanModel(settingRes.value ?? "");
      } catch {
        // Non-fatal — picker just stays empty.
      }
    })();
  }, []);

  async function saveScanModel(next: string): Promise<void> {
    setSavingScanModel(true);
    setScanModel(next);
    try {
      await apiJson("/api/settings/IMAGE_SCAN_MODEL", "PUT", { value: next === "" ? null : next });
      toast.success(next === "" ? "Scanner uses main agent's model" : `Scanner set to ${next}`);
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setSavingScanModel(false);
    }
  }

  // Poll while any image is still scanning so the badges update.
  const hasScanning = useMemo(
    () => projects.some((p) => p.files.some(
      (f) => f.scanStatus === "pending" || f.scanStatus === "scanning",
    )),
    [projects],
  );
  useEffect(() => {
    if (!hasScanning) return;
    const t = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [hasScanning, load]);

  const activeProject = projects.find((p) => p.slug === activeSlug) ?? null;

  async function createProject(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const description = newDescription.trim();
      const res = await apiJson<{ project: FileProject }>(
        "/api/file-projects",
        "POST",
        { name, ...(description ? { description } : {}) },
      );
      setNewName("");
      setNewDescription("");
      await load();
      setActiveSlug(res.project.slug);
      toast.success(`Created project '${res.project.name}'`);
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function saveDescription(): Promise<void> {
    if (!activeProject) return;
    setSavingDescription(true);
    try {
      await apiFetch(`/api/file-projects/${encodeURIComponent(activeProject.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: descriptionDraft }),
      });
      setEditingDescription(false);
      await load();
      toast.success("Description saved");
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setSavingDescription(false);
    }
  }

  async function confirmDeleteProject(): Promise<void> {
    if (!deleteProjectTarget) return;
    const slug = deleteProjectTarget.slug;
    setDeletingProject(true);
    try {
      await apiFetch(`/api/file-projects/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (activeSlug === slug) setActiveSlug(null);
      setDeleteProjectTarget(null);
      await load();
      toast.success("Project deleted");
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setDeletingProject(false);
    }
  }

  async function uploadFile(file: File): Promise<void> {
    if (!activeProject) return;
    setUploadBusy(true);
    try {
      const base64 = await fileToBase64(file);
      await apiJson<{ file: FileRecord }>(
        `/api/file-projects/${encodeURIComponent(activeProject.slug)}/files`,
        "POST",
        {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          base64,
        },
      );
      await load();
      toast.success(`Uploaded ${file.name}`);
    } catch (e) {
      toast.error(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploadBusy(false);
    }
  }

  async function renameFile(fileId: string): Promise<void> {
    if (!activeProject) return;
    const filename = renameDraft.trim();
    if (!filename) return;
    try {
      await apiJson<{ file: FileRecord }>(
        `/api/file-projects/${encodeURIComponent(activeProject.slug)}/files/${encodeURIComponent(fileId)}`,
        "PATCH",
        { filename },
      );
      setRenamingFileId(null);
      setRenameDraft("");
      await load();
    } catch (e) {
      toast.error(`Rename failed: ${(e as Error).message}`);
    }
  }

  async function confirmDeleteFile(): Promise<void> {
    if (!activeProject || !deleteFileTarget) return;
    setDeletingFile(true);
    try {
      await apiFetch(
        `/api/file-projects/${encodeURIComponent(activeProject.slug)}/files/${encodeURIComponent(deleteFileTarget.id)}`,
        { method: "DELETE" },
      );
      setDeleteFileTarget(null);
      await load();
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setDeletingFile(false);
    }
  }

  async function viewFiler(fileId: string): Promise<void> {
    if (!activeProject) return;
    try {
      const res = await apiFetch(
        `/api/file-projects/${encodeURIComponent(activeProject.slug)}/files/${encodeURIComponent(fileId)}/filer`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const markdown = await res.text();
      setFilerOpen({ slug: activeProject.slug, fileId, markdown });
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Folder className="w-6 h-6 text-[#00d9ff]" />
            Gallery
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Curated folders of reference assets. The agent calls <code className="text-[#00d9ff] font-mono text-xs">list_gallery_projects</code> to see what's here and pulls files in when relevant.
          </p>
        </div>
        <div className="shrink-0 min-w-[260px]">
          <label className="text-[10px] uppercase tracking-widest text-gray-500 font-mono mb-1 block">
            Scanner model {savingScanModel && <Loader2 className="w-3 h-3 inline animate-spin ml-1" />}
          </label>
          <select
            value={scanModel}
            onChange={(e) => void saveScanModel(e.target.value)}
            disabled={savingScanModel}
            className="w-full bg-slate-950/60 border border-slate-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-[#00d9ff] disabled:opacity-50"
          >
            <option value="">Default (main agent's model)</option>
            {providers.filter((p) => p.configured && p.models.length > 0).map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-[10px] text-gray-500 mt-1">
            Used to auto-describe uploaded images. All vision-capable models supported.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* Project list */}
        <div className="space-y-3">
          <div className="bg-slate-900/40 border border-slate-800/60 rounded-lg p-4 space-y-2">
            <div className="text-xs uppercase tracking-widest text-gray-500 font-mono mb-2">New Project</div>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. AuditionAid)"
              className="w-full bg-slate-950/60 border border-slate-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-[#00d9ff]"
            />
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Purpose / brief — what's this project for? (the agent reads this)"
              rows={3}
              className="w-full bg-slate-950/60 border border-slate-700 text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-[#00d9ff] resize-none"
            />
            <button
              type="button"
              onClick={() => void createProject()}
              disabled={creating || !newName.trim()}
              className="w-full px-3 py-1.5 bg-[#00d9ff]/10 border border-[#00d9ff]/40 text-[#00d9ff] text-sm rounded hover:bg-[#00d9ff]/20 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />}
              Create
            </button>
          </div>

          <div className="bg-slate-900/40 border border-slate-800/60 rounded-lg overflow-hidden">
            {loading && (
              <div className="p-4 text-sm text-gray-400 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && projects.length === 0 && (
              <div className="p-4 text-sm text-gray-500">No projects yet. Create one above.</div>
            )}
            {projects.map((p) => (
              <button
                key={p.slug}
                onClick={() => setActiveSlug(p.slug)}
                className={`w-full text-left px-4 py-3 flex items-center justify-between border-b border-slate-800/50 last:border-b-0 transition-colors ${
                  activeSlug === p.slug ? "bg-[#00d9ff]/10 text-[#00d9ff]" : "text-gray-300 hover:bg-slate-800/40"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Folder className="w-4 h-4 shrink-0" style={p.color ? { color: p.color } : undefined} />
                  <span className="truncate text-sm font-medium">{p.name}</span>
                </div>
                <span className="text-[10px] font-mono text-gray-500">{p.files.length}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Active project files */}
        <div className="bg-slate-900/40 border border-slate-800/60 rounded-lg p-5">
          {!activeProject && (
            <div className="text-sm text-gray-500 py-12 text-center">
              Select or create a project to upload files.
            </div>
          )}

          {activeProject && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-bold text-white flex items-center gap-2">
                    <Folder className="w-5 h-5" style={activeProject.color ? { color: activeProject.color } : undefined} />
                    {activeProject.name}
                  </div>
                  <div className="text-xs text-gray-500 font-mono mt-0.5">{activeProject.slug}</div>
                </div>
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        void uploadFile(f);
                        e.target.value = "";
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadBusy}
                    className="px-3 py-1.5 bg-[#00d9ff]/10 border border-[#00d9ff]/40 text-[#00d9ff] text-sm rounded hover:bg-[#00d9ff]/20 disabled:opacity-50 flex items-center gap-2"
                  >
                    {uploadBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    Upload
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteProjectTarget(activeProject)}
                    className="px-3 py-1.5 bg-red-500/10 border border-red-500/40 text-red-400 text-sm rounded hover:bg-red-500/20 flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete project
                  </button>
                </div>
              </div>

              {/* Description — shown to the agent when it lists gallery projects. */}
              <div className="bg-slate-950/40 border border-slate-800/60 rounded p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">Purpose / brief</div>
                  {!editingDescription && (
                    <button
                      type="button"
                      onClick={() => {
                        setDescriptionDraft(activeProject.description ?? "");
                        setEditingDescription(true);
                      }}
                      className="text-[10px] uppercase tracking-widest text-[#00d9ff] hover:underline font-mono"
                    >
                      {activeProject.description ? "Edit" : "Add"}
                    </button>
                  )}
                </div>
                {editingDescription ? (
                  <div className="space-y-2">
                    <textarea
                      value={descriptionDraft}
                      onChange={(e) => setDescriptionDraft(e.target.value)}
                      rows={4}
                      placeholder="What's this project for? The agent reads this in list_gallery_projects."
                      className="w-full bg-slate-950 border border-slate-700 text-white text-sm rounded px-2 py-1.5 focus:outline-none focus:border-[#00d9ff] resize-y"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setEditingDescription(false)}
                        className="px-3 py-1 text-xs text-gray-400 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveDescription()}
                        disabled={savingDescription}
                        className="px-3 py-1 bg-[#00d9ff]/10 border border-[#00d9ff]/40 text-[#00d9ff] text-xs rounded hover:bg-[#00d9ff]/20 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {savingDescription && <Loader2 className="w-3 h-3 animate-spin" />}
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-gray-300 whitespace-pre-wrap">
                    {activeProject.description?.trim() || (
                      <span className="text-gray-600 italic">No description yet — click Add to tell the agent what this project is for.</span>
                    )}
                  </div>
                )}
              </div>

              {activeProject.files.length === 0 ? (
                <div className="border border-dashed border-slate-700 rounded-lg py-12 text-center text-sm text-gray-500">
                  Drag a file or click Upload. Images get auto-described via vision model.
                </div>
              ) : (
                <ul className="divide-y divide-slate-800/50 border border-slate-800/60 rounded">
                  {activeProject.files.map((f) => (
                    <li key={f.id} className="px-4 py-3 flex items-center gap-3">
                      <FileIconFor kind={f.kind} />
                      <div className="flex-1 min-w-0">
                        {renamingFileId === f.id ? (
                          <input
                            type="text"
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void renameFile(f.id);
                              if (e.key === "Escape") { setRenamingFileId(null); setRenameDraft(""); }
                            }}
                            onBlur={() => { setRenamingFileId(null); setRenameDraft(""); }}
                            className="w-full bg-slate-950 border border-[#00d9ff]/40 text-white text-sm rounded px-2 py-0.5 focus:outline-none"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setRenamingFileId(f.id); setRenameDraft(f.filename); }}
                            className="text-sm text-white truncate text-left hover:text-[#00d9ff] transition-colors"
                            title="Click to rename — agent uses this name semantically (logo, bg, etc.)"
                          >
                            {f.filename}
                          </button>
                        )}
                        <div className="text-[11px] text-gray-500 font-mono mt-0.5">
                          {f.kind} · {(f.size / 1024).toFixed(1)} KB
                        </div>
                      </div>
                      <ScanBadge file={f} />
                      {f.filerPath && (
                        <button
                          type="button"
                          onClick={() => void viewFiler(f.id)}
                          className="text-xs text-[#00d9ff] hover:underline"
                        >
                          View filer
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeleteFileTarget(f)}
                        className="text-gray-500 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!deleteProjectTarget}
        onOpenChange={(o) => !o && !deletingProject && setDeleteProjectTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project '{deleteProjectTarget?.name}'?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the project folder and all {deleteProjectTarget?.files.length ?? 0} file(s) inside it, including any image filers. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingProject}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteProject()} disabled={deletingProject}>
              {deletingProject ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteFileTarget}
        onOpenChange={(o) => !o && !deletingFile && setDeleteFileTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete '{deleteFileTarget?.filename}'?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the file and its filer (if any) from the project. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingFile}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteFile()} disabled={deletingFile}>
              {deletingFile ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Filer modal */}
      {filerOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-6"
          onClick={() => setFilerOpen(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-3xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-slate-800">
              <div className="text-sm text-white font-mono">Image filer</div>
              <button type="button" onClick={() => setFilerOpen(null)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="p-4 text-sm text-gray-200 whitespace-pre-wrap font-mono">{filerOpen.markdown}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function FileIconFor({ kind }: { kind: FileKind }): JSX.Element {
  if (kind === "image") return <ImageIcon className="w-5 h-5 text-purple-400 shrink-0" />;
  if (kind === "pdf" || kind === "document" || kind === "text") return <FileText className="w-5 h-5 text-blue-400 shrink-0" />;
  return <FileIcon className="w-5 h-5 text-gray-400 shrink-0" />;
}

function ScanBadge({ file }: { file: FileRecord }): JSX.Element | null {
  if (!file.scanStatus || file.scanStatus === "skipped") return null;
  if (file.scanStatus === "completed") {
    return (
      <span className="text-[10px] font-mono uppercase text-[#00ff88] flex items-center gap-1">
        <CheckCircle className="w-3 h-3" /> scanned
      </span>
    );
  }
  if (file.scanStatus === "failed") {
    return (
      <span className="text-[10px] font-mono uppercase text-red-400 flex items-center gap-1" title={file.scanError ?? ""}>
        <AlertTriangle className="w-3 h-3" /> failed
      </span>
    );
  }
  return (
    <span className="text-[10px] font-mono uppercase text-yellow-400 flex items-center gap-1">
      <Loader2 className="w-3 h-3 animate-spin" /> scanning
    </span>
  );
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result format: "data:<mime>;base64,<payload>" — strip the prefix.
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
