import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Search, Clock, CheckCircle2, AlertCircle, Loader2, ChevronRight, ChevronDown, Bot } from "lucide-react";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";

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

interface Task {
  id: string;
  status: string;
  type: string;
  title: string | null;
  channel: string;
  input: string;
  cost: { estimatedCost?: number; inputTokens?: number; outputTokens?: number; modelCalls?: number } | number;
  parentTaskId: string | null;
  agentId: string | null;
  agentCreated: boolean;
  subAgents: SubAgent[] | null;
  createdAt: string;
  completedAt: string | null;
}

interface ChildTask {
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

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Record<string, ChildTask[]>>({});

  const fetchTasks = async () => {
    try {
      const res = await fetch("/api/tasks?limit=50");
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch (error) {
      console.error("Failed to fetch tasks", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    fetchTasks();
    const interval = setInterval(fetchTasks, 15000);
    return () => clearInterval(interval);
  }, []);

  const toggleExpand = async (taskId: string) => {
    const next = new Set(expandedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
      if (!childrenMap[taskId]) {
        try {
          const res = await fetch(`/api/tasks/${taskId}/children`);
          if (res.ok) {
            const data = await res.json();
            setChildrenMap(prev => ({ ...prev, [taskId]: data.children || [] }));
          }
        } catch { /* ignore */ }
      }
    }
    setExpandedTasks(next);
  };

  const filteredTasks = tasks
    .filter((task) => !task.parentTaskId)
    .filter((task) =>
      (task.title || task.input || "").toLowerCase().includes(search.toLowerCase()) ||
      task.id.toLowerCase().includes(search.toLowerCase())
    );

  const StatusIcon = ({ status }: { status: string }) => {
    if (status === "running" || status === "in_progress") return <Clock className="w-4 h-4 text-[#ffaa00] animate-pulse" />;
    if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-[#00ff88]" />;
    if (status === "failed") return <AlertCircle className="w-4 h-4 text-[#ff4458]" />;
    return <Clock className="w-4 h-4 text-gray-600" />;
  };

  const CostDisplay = ({ cost }: { cost: Task["cost"] }) => {
    if (typeof cost === "object" && cost?.estimatedCost) return <span>${cost.estimatedCost.toFixed(4)}</span>;
    if (typeof cost === "number" && cost > 0) return <span>${cost.toFixed(4)}</span>;
    return <span>-</span>;
  };

  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Tasks</h2>
          <p className="text-gray-400 font-mono text-sm tracking-widest">EXECUTION HISTORY</p>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <Input
            placeholder="SEARCH BY TITLE, INPUT OR TASK ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-slate-900/50 border-slate-800 text-white font-mono text-xs tracking-wider"
          />
        </div>
      </div>

      {/* Task List */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl overflow-hidden">
        <CardHeader className="border-b border-slate-800/50 bg-slate-800/20 py-4">
          <div className="grid grid-cols-12 gap-4 text-[10px] font-mono text-gray-500 uppercase tracking-widest px-6">
            <div className="col-span-1">Status</div>
            <div className="col-span-2">ID</div>
            <div className="col-span-4">Input</div>
            <div className="col-span-1">Channel</div>
            <div className="col-span-2 text-right">Cost</div>
            <div className="col-span-2 text-right">Created</div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-slate-800/50">
            {filteredTasks.length === 0 ? (
              <div className="text-center py-20">
                <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">
                  NO TASKS YET
                </p>
              </div>
            ) : (
              filteredTasks.map((task) => {
                const hasChildren = (task.subAgents && task.subAgents.length > 0) || task.agentCreated;
                const isExpanded = expandedTasks.has(task.id);
                const children = childrenMap[task.id] || [];

                return (
                  <div key={task.id}>
                    {/* Main task row */}
                    <div className="grid grid-cols-12 gap-4 p-4 px-6 items-center hover:bg-[#00d9ff]/5 transition-colors group">
                      <div className="col-span-1 flex items-center gap-1">
                        {hasChildren && (
                          <button onClick={() => toggleExpand(task.id)} className="text-gray-500 hover:text-white">
                            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          </button>
                        )}
                        <StatusIcon status={task.status} />
                      </div>
                      <div className="col-span-2 font-mono text-[10px] text-gray-400 truncate uppercase">
                        <Link to={`/tasks/${task.id}`} className="hover:text-[#00d9ff]">
                          {task.id.split("-")[0]}...
                        </Link>
                      </div>
                      <div className="col-span-4 text-sm text-gray-200 truncate group-hover:text-[#00d9ff] transition-colors font-mono">
                        <Link to={`/tasks/${task.id}`}>
                          {task.title || task.input}
                        </Link>
                      </div>
                      <div className="col-span-1">
                        <Badge variant="outline" className="bg-slate-800/50 border-slate-700 text-[9px] font-mono text-gray-400 uppercase">
                          {task.channel}
                        </Badge>
                      </div>
                      <div className="col-span-2 text-right font-mono text-[10px] text-[#00ff88]">
                        <CostDisplay cost={task.cost} />
                      </div>
                      <div className="col-span-2 text-right font-mono text-[10px] text-gray-500 uppercase">
                        {new Date(task.createdAt).toLocaleDateString()} {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>

                    {/* Expanded: Child tasks */}
                    {isExpanded && children.length > 0 && (
                      <div className="bg-slate-900/80 border-l-2 border-[#00d9ff]/20 ml-10">
                        {children.map((child) => (
                          <Link
                            key={child.id}
                            to={`/tasks/${child.id}`}
                            className="grid grid-cols-12 gap-4 p-3 px-6 items-center hover:bg-[#00d9ff]/5 transition-colors text-sm"
                          >
                            <div className="col-span-1">
                              <StatusIcon status={child.status} />
                            </div>
                            <div className="col-span-2 font-mono text-[10px] text-gray-500 truncate uppercase">
                              {child.id.split("-")[0]}...
                            </div>
                            <div className="col-span-4 text-gray-300 truncate font-mono text-xs">
                              {child.title || child.input}
                            </div>
                            <div className="col-span-1">
                              {child.agentId && (
                                <Badge variant="outline" className="bg-[#7C6AFF]/10 border-[#7C6AFF]/30 text-[8px] font-mono text-[#7C6AFF]">
                                  <Bot className="w-2 h-2 mr-1" />
                                  {child.agentId.slice(0, 6)}
                                </Badge>
                              )}
                            </div>
                            <div className="col-span-2 text-right font-mono text-[10px] text-[#00ff88]">
                              <CostDisplay cost={child.cost} />
                            </div>
                            <div className="col-span-2 text-right font-mono text-[10px] text-gray-600">
                              {new Date(child.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}

                    {/* Expanded: Sub-agents */}
                    {isExpanded && task.subAgents && task.subAgents.length > 0 && (
                      <div className="bg-slate-900/80 border-l-2 border-[#7C6AFF]/20 ml-10 p-4">
                        <div className="text-[10px] font-mono text-[#7C6AFF] uppercase tracking-widest mb-2">Sub-Agents</div>
                        <div className="space-y-2">
                          {task.subAgents.map((sa) => (
                            <div key={sa.agentId} className="flex items-center justify-between text-xs font-mono bg-slate-800/30 rounded p-2">
                              <div className="flex items-center gap-2">
                                <StatusIcon status={sa.status} />
                                <span className="text-gray-300">{sa.role || "agent"}</span>
                                <span className="text-gray-600">({sa.agentId.slice(0, 8)})</span>
                                {sa.model && <span className="text-gray-600 text-[9px]">{sa.model}</span>}
                              </div>
                              <div className="flex items-center gap-3">
                                {sa.toolCalls?.length ? (
                                  <span className="text-gray-500 text-[9px]">{sa.toolCalls.length} tools</span>
                                ) : null}
                                {sa.resultPreview && (
                                  <span className="text-gray-500 text-[9px] max-w-[200px] truncate">{sa.resultPreview}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Expanded: no children */}
                    {isExpanded && children.length === 0 && (!task.subAgents || task.subAgents.length === 0) && (
                      <div className="bg-slate-900/80 border-l-2 border-slate-800 ml-10 p-4">
                        <p className="text-gray-600 font-mono text-[10px] uppercase">No child tasks or sub-agents</p>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
