import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Link } from "react-router";
import { Search, Clock, CheckCircle2, AlertCircle, Loader2, ChevronRight, ChevronDown, Bot, Trash2, Zap, Filter } from "lucide-react";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { toast } from "sonner";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from "../components/ui/alert-dialog";

interface SubAgent {
  agentId: string;
  role?: string;
  model?: string;
  status: string;
  toolCalls?: { tool: string; duration?: number }[];
  resultPreview?: string;
  cost?: { estimatedCost?: number } | number | null;
  startedAt?: string;
  completedAt?: string;
}

interface LogEntry {
  id: string;
  status: string;
  type: string;
  title: string | null;
  channel: string;
  input: string;
  cost: { estimatedCost?: number; inputTokens?: number; outputTokens?: number; modelCalls?: number; model?: string } | number;
  parentTaskId: string | null;
  agentId: string | null;
  agentCreated: boolean;
  subAgents: SubAgent[] | null;
  toolCalls?: { tool: string; status?: string }[];
  createdAt: string;
  completedAt: string | null;
  startedAt: string | null;
}

interface ChildEntry {
  id: string;
  status: string;
  type: string;
  title: string | null;
  input: string;
  agentId: string | null;
  cost: { estimatedCost?: number } | number;
  createdAt: string;
  completedAt: string | null;
}

const STATUS_FILTERS = [
  { value: "all", label: "All", color: "text-gray-400 border-gray-700" },
  { value: "running", label: "Running", color: "text-[#ffaa00] border-[#ffaa00]/30" },
  { value: "completed", label: "Completed", color: "text-[#00ff88] border-[#00ff88]/30" },
  { value: "failed", label: "Failed", color: "text-[#ff4458] border-[#ff4458]/30" },
];

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Record<string, ChildEntry[]>>({});
  const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; description?: string; onConfirm: () => void }>({ open: false, title: "", onConfirm: () => {} });

  const fetchEntries = async () => {
    try {
      const res = await apiFetch("/api/tasks?limit=100");
      if (res.ok) {
        const data = await res.json();
        setEntries(data.tasks || []);
      }
    } catch (error) {
      console.error("Failed to fetch logs", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    fetchEntries();
    const interval = setInterval(fetchEntries, 10000);
    return () => clearInterval(interval);
  }, []);

  const toggleExpand = async (entryId: string) => {
    const next = new Set(expandedEntries);
    if (next.has(entryId)) {
      next.delete(entryId);
    } else {
      next.add(entryId);
      if (!childrenMap[entryId]) {
        try {
          const res = await apiFetch(`/api/tasks/${entryId}/children`);
          if (res.ok) {
            const data = await res.json();
            setChildrenMap(prev => ({ ...prev, [entryId]: data.children || [] }));
          }
        } catch { /* ignore */ }
      }
    }
    setExpandedEntries(next);
  };

  const handleDelete = (e: React.MouseEvent, entryId: string, status: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === "running") { toast.error("Cannot delete a running entry"); return; }
    setConfirmState({
      open: true,
      title: "Delete this log entry?",
      description: "This action cannot be undone.",
      onConfirm: async () => {
        const toastId = toast.loading("Deleting...");
        try {
          const res = await apiFetch(`/api/tasks/${entryId}`, { method: "DELETE" });
          if (res.ok) { toast.success("Entry deleted", { id: toastId }); fetchEntries(); }
          else { const err = await res.json(); toast.error(err.error || "Failed to delete", { id: toastId }); }
        } catch (err: any) { toast.error(err.message, { id: toastId }); }
      },
    });
  };

  const filteredEntries = entries
    .filter((e) => !e.parentTaskId)
    .filter((e) => statusFilter === "all" || e.status === statusFilter || (statusFilter === "running" && e.status === "in_progress"))
    .filter((e) =>
      (e.title || e.input || "").toLowerCase().includes(search.toLowerCase()) ||
      e.id.toLowerCase().includes(search.toLowerCase())
    );

  const StatusIcon = ({ status }: { status: string }) => {
    if (status === "running" || status === "in_progress") return <div className="w-2 h-2 rounded-full bg-[#ffaa00] animate-pulse" />;
    if (status === "completed") return <div className="w-2 h-2 rounded-full bg-[#00ff88]" />;
    if (status === "failed") return <div className="w-2 h-2 rounded-full bg-[#ff4458]" />;
    return <div className="w-2 h-2 rounded-full bg-gray-600" />;
  };

  const CostDisplay = ({ cost }: { cost: LogEntry["cost"] }) => {
    if (typeof cost === "object" && cost?.estimatedCost) return <span>${cost.estimatedCost.toFixed(4)}</span>;
    if (typeof cost === "number" && cost > 0) return <span>${cost.toFixed(4)}</span>;
    return <span className="text-gray-700">-</span>;
  };

  const formatDuration = (start: string | null, end: string | null) => {
    if (!start) return null;
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const secs = Math.floor((e - s) / 1000);
    if (secs < 1) return "<1s";
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
  };

  const getToolCount = (entry: LogEntry) => {
    if (entry.toolCalls?.length) return entry.toolCalls.length;
    if (typeof entry.cost === "object" && entry.cost?.modelCalls) return entry.cost.modelCalls;
    return 0;
  };

  const getSubAgentCount = (entry: LogEntry) => entry.subAgents?.length || 0;

  // Count stats
  const runningCount = entries.filter(e => !e.parentTaskId && (e.status === "running" || e.status === "in_progress")).length;
  const completedCount = entries.filter(e => !e.parentTaskId && e.status === "completed").length;
  const failedCount = entries.filter(e => !e.parentTaskId && e.status === "failed").length;

  if (isLoading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white uppercase tracking-tighter">Logs</h2>
          <p className="text-gray-500 font-mono text-[10px] tracking-widest uppercase">Execution History</p>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          {runningCount > 0 && <span className="text-[#ffaa00]">{runningCount} running</span>}
          <span className="text-gray-600">{entries.filter(e => !e.parentTaskId).length} total</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        {/* Status pills */}
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-2.5 py-1 rounded-md text-[9px] font-mono uppercase tracking-wider border transition-all ${
                statusFilter === f.value
                  ? `${f.color} bg-white/5`
                  : "text-gray-600 border-transparent hover:text-gray-400"
              }`}
            >
              {f.label}
              {f.value === "running" && runningCount > 0 && <span className="ml-1">({runningCount})</span>}
              {f.value === "completed" && <span className="ml-1">({completedCount})</span>}
              {f.value === "failed" && failedCount > 0 && <span className="ml-1">({failedCount})</span>}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 bg-slate-900/50 border-slate-800 text-white font-mono text-[10px] tracking-wider"
          />
        </div>
      </div>

      {/* Log List */}
      <div className="space-y-1">
        {filteredEntries.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-700 font-mono uppercase tracking-widest text-[10px]">
              {statusFilter !== "all" ? `No ${statusFilter} entries` : "No log entries yet"}
            </p>
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const hasChildren = (entry.subAgents && entry.subAgents.length > 0) || entry.agentCreated;
            const isExpanded = expandedEntries.has(entry.id);
            const children = childrenMap[entry.id] || [];
            const toolCount = getToolCount(entry);
            const agentCount = getSubAgentCount(entry);
            const duration = formatDuration(entry.startedAt || entry.createdAt, entry.completedAt);
            const model = typeof entry.cost === "object" ? entry.cost?.model : null;

            return (
              <div key={entry.id} className="rounded-lg overflow-hidden">
                {/* Main row */}
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/30 transition-colors group">
                  {/* Expand + Status */}
                  <div className="flex items-center gap-2 w-8 flex-shrink-0">
                    {hasChildren ? (
                      <button onClick={() => toggleExpand(entry.id)} className="text-gray-600 hover:text-white">
                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </button>
                    ) : <div className="w-3.5" />}
                    <StatusIcon status={entry.status} />
                  </div>

                  {/* Input text */}
                  <Link to={`/logs/${entry.id}`} className="flex-1 min-w-0 group-hover:text-[#00d9ff] transition-colors">
                    <span className="text-sm text-gray-200 font-mono truncate block">
                      {(entry.title || entry.input || "").replace(/^\[Voice mode:[^\]]+\]\s*/, "")}
                    </span>
                  </Link>

                  {/* Badges row */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Channel */}
                    <span className="text-[8px] font-mono text-gray-600 uppercase bg-slate-800/50 px-1.5 py-0.5 rounded">
                      {entry.channel}
                    </span>

                    {/* Model */}
                    {model && (
                      <span className="text-[8px] font-mono text-gray-600 bg-slate-800/50 px-1.5 py-0.5 rounded hidden xl:inline">
                        {model.split("/").pop()?.split(":")[0] || model}
                      </span>
                    )}

                    {/* Tool count */}
                    {toolCount > 0 && (
                      <span className="text-[9px] font-mono text-[#7C6AFF] flex items-center gap-0.5">
                        <Zap className="w-2.5 h-2.5" />{toolCount}
                      </span>
                    )}

                    {/* Sub-agent count */}
                    {agentCount > 0 && (
                      <span className="text-[9px] font-mono text-[#00d9ff] flex items-center gap-0.5">
                        <Bot className="w-2.5 h-2.5" />{agentCount}
                      </span>
                    )}

                    {/* Duration */}
                    {duration && (
                      <span className="text-[9px] font-mono text-gray-600 w-12 text-right">
                        {duration}
                      </span>
                    )}

                    {/* Cost */}
                    <span className="text-[9px] font-mono text-[#00ff88] w-16 text-right">
                      <CostDisplay cost={entry.cost} />
                    </span>

                    {/* Time */}
                    <span className="text-[9px] font-mono text-gray-700 w-14 text-right hidden lg:inline">
                      {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>

                    {/* Delete */}
                    <button
                      onClick={(e) => handleDelete(e, entry.id, entry.status)}
                      disabled={entry.status === "running"}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500/30 hover:text-red-500 disabled:opacity-0 p-0.5"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Expanded: Sub-agents */}
                {isExpanded && entry.subAgents && entry.subAgents.length > 0 && (
                  <div className="border-l-2 border-[#7C6AFF]/20 ml-8 bg-slate-900/30">
                    {entry.subAgents.map((sa) => (
                      <div key={sa.agentId} className="flex items-center gap-3 px-4 py-2 text-[11px] font-mono">
                        <Bot className="w-3 h-3 text-[#7C6AFF] flex-shrink-0" />
                        <StatusIcon status={sa.status} />
                        <span className="text-[#7C6AFF]">{sa.role || "agent"}</span>
                        <span className="text-gray-700">({sa.agentId.slice(0, 8)})</span>
                        {sa.model && <span className="text-gray-700 text-[9px]">{sa.model.split("/").pop()}</span>}
                        <span className="flex-1" />
                        {sa.toolCalls?.length ? <span className="text-gray-600 text-[9px]">{sa.toolCalls.length} tools</span> : null}
                        {sa.resultPreview && <span className="text-gray-600 text-[9px] max-w-[250px] truncate">{sa.resultPreview}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Expanded: Child entries */}
                {isExpanded && children.length > 0 && (
                  <div className="border-l-2 border-[#00d9ff]/20 ml-8 bg-slate-900/30">
                    {children.map((child) => (
                      <Link
                        key={child.id}
                        to={`/logs/${child.id}`}
                        className="flex items-center gap-3 px-4 py-2 text-[11px] font-mono hover:bg-[#00d9ff]/5 transition-colors"
                      >
                        <StatusIcon status={child.status} />
                        <span className="text-gray-400 truncate flex-1">{child.title || child.input}</span>
                        {child.agentId && (
                          <span className="text-[8px] text-[#7C6AFF]">{child.agentId.slice(0, 6)}</span>
                        )}
                        <span className="text-[9px] text-[#00ff88]"><CostDisplay cost={child.cost} /></span>
                      </Link>
                    ))}
                  </div>
                )}

                {isExpanded && children.length === 0 && (!entry.subAgents || entry.subAgents.length === 0) && (
                  <div className="border-l-2 border-slate-800/50 ml-8 px-4 py-2">
                    <span className="text-gray-700 font-mono text-[9px] uppercase">No sub-agents or child entries</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <AlertDialog open={confirmState.open} onOpenChange={(open) => setConfirmState((s) => ({ ...s, open }))}>
        <AlertDialogContent className="bg-slate-900 border border-slate-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white font-mono uppercase text-sm tracking-wide">{confirmState.title}</AlertDialogTitle>
            {confirmState.description && (
              <AlertDialogDescription className="text-gray-400 font-mono text-xs">{confirmState.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-800 border-slate-700 text-gray-300 hover:bg-slate-700 font-mono text-xs uppercase">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 font-mono text-xs uppercase"
              onClick={() => { confirmState.onConfirm(); setConfirmState((s) => ({ ...s, open: false })); }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
