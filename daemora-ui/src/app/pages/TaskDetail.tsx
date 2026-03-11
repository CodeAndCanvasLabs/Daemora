import { useParams, Link, useNavigate } from "react-router";
import { apiFetch, apiStreamUrl } from "../api";
import { useEffect, useState } from "react";
import { ArrowLeft, Clock, DollarSign, Cpu, Loader2, AlertTriangle, Zap, GitBranch, CheckCircle2, XCircle, Bot, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ToolCall {
  tool: string;
  params: any[];
  duration: number;
  output_preview: string;
  status: "success" | "error";
  step: number;
}

interface SubAgent {
  agentId: string;
  taskId: string;
  description: string;
  depth: number;
  status: string;
  role?: string;
  model?: string;
  toolCalls?: any[];
  resultPreview?: string;
  startedAt: string;
  completedAt?: string;
  cost?: { estimatedCost?: number; model?: string } | null;
  error?: string | null;
}

interface TaskData {
  id: string;
  status: string;
  input: string;
  result: string | null;
  error: string | null;
  channel: string;
  sessionId: string | null;
  priority: number;
  cost: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    modelCalls: number;
    model?: string;
  };
  toolCalls: ToolCall[];
  subAgents?: SubAgent[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const handleDelete = async () => {
    if (!confirm("Delete this task? This cannot be undone.")) return;
    const toastId = toast.loading("DELETING TASK...");
    try {
      const res = await apiFetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Task deleted", { id: toastId });
        navigate("/tasks");
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to delete", { id: toastId });
      }
    } catch (e: any) {
      toast.error(e.message, { id: toastId });
    }
  };

  useEffect(() => {
    if (!id) return;
    const fetchTask = async () => {
      try {
        const res = await apiFetch(`/api/tasks/${id}`);
        if (res.ok) {
          const data = await res.json();
          setTask(data);
        }
      } catch (err) {
        console.error("Failed to fetch task", err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchTask();

    // If task is running, set up SSE stream
    if (task?.status === "running") {
      const es = new EventSource(apiStreamUrl(`/api/tasks/${id}/stream`));
      es.addEventListener("task:completed", (e) => {
        setTask(JSON.parse(e.data));
      });
      es.addEventListener("tool:after", () => fetchTask());
      es.addEventListener("agent:spawned", () => fetchTask());
      es.addEventListener("agent:finished", () => fetchTask());
      es.addEventListener("task:failed", (e) => {
        setTask(JSON.parse(e.data));
      });
      return () => es.close();
    }

    // Poll if running
    const interval = setInterval(() => {
      if (task?.status === "running" || task?.status === "pending") fetchTask();
    }, 3000);
    return () => clearInterval(interval);
  }, [id, task?.status]);

  const formatDuration = (start: string | null, end: string | null) => {
    if (!start) return "-";
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const secs = Math.floor((e - s) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}m ${remSecs}s`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400 font-mono uppercase">TASK NOT FOUND</p>
      </div>
    );
  }

  const statusColor = task.status === "completed" ? "bg-[#00ff88]/20 text-[#00ff88] border-[#00ff88]/30"
    : task.status === "failed" ? "bg-red-500/20 text-red-400 border-red-500/30"
    : task.status === "running" ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
    : "bg-slate-700/20 text-gray-400 border-slate-700/30";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/tasks">
          <Button variant="outline" size="icon" className="bg-slate-900 border-slate-800 text-white hover:bg-slate-800">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-white font-mono uppercase tracking-tight truncate">{task.input.slice(0, 80)}</h2>
          <p className="text-gray-500 font-mono text-[10px] uppercase tracking-wider mt-1">
            {task.id} // {task.channel} {task.cost?.model && `// ${task.cost.model}`}
          </p>
        </div>
        <Badge className={statusColor}>
          {task.status}
        </Badge>
        <Button
          variant="outline"
          size="icon"
          onClick={handleDelete}
          disabled={task.status === "running"}
          className="bg-slate-900 border-slate-800 text-red-400 hover:bg-red-500/10 hover:border-red-500/30 disabled:opacity-30"
          title="Delete task"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Priority</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="text-xl font-bold text-white font-mono">{task.priority}/10</div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Duration</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#00d9ff]" />
              <div className="text-xl font-bold text-white font-mono">{formatDuration(task.startedAt, task.completedAt)}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Cost</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-[#00ff88]" />
              <div className="text-xl font-bold text-white font-mono">${(task.cost?.estimatedCost || 0).toFixed(4)}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Tool Calls</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-[#7C6AFF]" />
              <div className="text-xl font-bold text-white font-mono">{task.toolCalls?.length || 0}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
        <CardContent className="p-0">
          <Tabs defaultValue="io" className="w-full">
            <TabsList className={`w-full grid bg-slate-800/50 border-b border-slate-700 rounded-none ${task.subAgents?.length ? "grid-cols-4" : "grid-cols-3"}`}>
              <TabsTrigger value="io" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff] font-mono text-xs uppercase">
                I/O
              </TabsTrigger>
              <TabsTrigger value="tools" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff] font-mono text-xs uppercase">
                Tool Calls ({task.toolCalls?.length || 0})
              </TabsTrigger>
              {task.subAgents && task.subAgents.length > 0 && (
                <TabsTrigger value="agents" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff] font-mono text-xs uppercase">
                  Sub-Agents ({task.subAgents.length})
                </TabsTrigger>
              )}
              <TabsTrigger value="costs" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff] font-mono text-xs uppercase">
                Cost
              </TabsTrigger>
            </TabsList>

            {/* Input / Output */}
            <TabsContent value="io" className="p-6 space-y-6">
              <div>
                <h3 className="text-xs font-mono text-gray-500 uppercase tracking-widest mb-3">Input</h3>
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                  <pre className="text-gray-300 text-sm font-mono whitespace-pre-wrap">{task.input}</pre>
                </div>
              </div>
              <div>
                <h3 className="text-xs font-mono text-gray-500 uppercase tracking-widest mb-3">
                  {task.error ? "Error" : "Output"}
                </h3>
                <div className={`bg-slate-800/50 border rounded-lg p-4 ${task.error ? "border-red-500/30" : "border-slate-700"}`}>
                  {task.error ? (
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                      <pre className="text-red-400 text-sm font-mono whitespace-pre-wrap">{task.error}</pre>
                    </div>
                  ) : task.result ? (
                    <div className="prose prose-invert prose-sm max-w-none font-mono leading-relaxed text-[13px]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {task.result}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-gray-600 font-mono text-sm italic">No output yet...</p>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* Tool Calls */}
            <TabsContent value="tools" className="p-6">
              {!task.toolCalls || task.toolCalls.length === 0 ? (
                <div className="text-center py-12">
                  <Zap className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                  <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">No tool calls recorded</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {task.toolCalls.map((tc, index) => (
                    <div
                      key={index}
                      className={`bg-slate-800/50 border rounded-lg p-4 ${tc.status === "error" ? "border-red-500/20" : "border-slate-700"}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className={`w-5 h-5 rounded flex items-center justify-center ${tc.status === "error" ? "bg-red-500/20" : "bg-[#00d9ff]/20"}`}>
                            <span className="text-[9px] font-mono font-bold text-gray-300">#{tc.step}</span>
                          </div>
                          <span className="font-bold text-white font-mono text-sm">{tc.tool}</span>
                          {tc.status === "error" && (
                            <Badge variant="outline" className="text-red-400 border-red-500/30 text-[9px] font-mono">ERROR</Badge>
                          )}
                        </div>
                        <span className="text-[10px] font-mono text-gray-500">{tc.duration}ms</span>
                      </div>
                      {tc.params && tc.params.length > 0 && (
                        <div className="mb-2">
                          <div className="text-[9px] font-mono text-gray-600 uppercase mb-1">Params</div>
                          <pre className="font-mono text-[11px] bg-slate-900/50 p-2 rounded border border-slate-800 text-gray-400 overflow-x-auto max-h-24 overflow-y-auto">
                            {JSON.stringify(tc.params, null, 2)}
                          </pre>
                        </div>
                      )}
                      {tc.output_preview && (
                        <div>
                          <div className="text-[9px] font-mono text-gray-600 uppercase mb-1">Output</div>
                          <pre className={`font-mono text-[11px] bg-slate-900/50 p-2 rounded border border-slate-800 overflow-x-auto max-h-32 overflow-y-auto ${tc.status === "error" ? "text-red-400" : "text-gray-400"}`}>
                            {tc.output_preview}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Sub-Agents */}
            {task.subAgents && task.subAgents.length > 0 && (
              <TabsContent value="agents" className="p-6">
                <div className="space-y-3">
                  {task.subAgents.map((sa, index) => (
                    <div key={index} className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3 flex-wrap">
                          <Bot className="w-4 h-4 text-[#7C6AFF] flex-shrink-0" />
                          <span className="font-mono text-sm text-white">{sa.agentId}</span>
                          <Badge variant="outline" className={`text-[9px] font-mono ${
                            sa.status === "completed" ? "text-[#00ff88] border-[#00ff88]/30"
                            : sa.status === "failed" ? "text-red-400 border-red-500/30"
                            : sa.status === "killed" ? "text-amber-400 border-amber-500/30"
                            : "text-[#00d9ff] border-[#00d9ff]/30"
                          }`}>
                            {sa.status}
                          </Badge>
                          {sa.role && (
                            <Badge variant="outline" className="text-[9px] font-mono text-[#7C6AFF] border-[#7C6AFF]/30">
                              {sa.role}
                            </Badge>
                          )}
                          {sa.depth > 0 && (
                            <span className="text-[9px] font-mono text-gray-600">depth: {sa.depth}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {sa.toolCalls && sa.toolCalls.length > 0 && (
                            <span className="text-[10px] font-mono text-gray-500 flex items-center gap-1">
                              <Zap className="w-3 h-3 text-[#7C6AFF]" />{sa.toolCalls.length}
                            </span>
                          )}
                          {sa.cost?.estimatedCost != null && (
                            <span className="text-[10px] font-mono text-gray-500">${sa.cost.estimatedCost.toFixed(4)}</span>
                          )}
                        </div>
                      </div>
                      <p className="text-gray-400 font-mono text-xs mb-2">{sa.description}</p>
                      {(sa.model || sa.cost?.model) && (
                        <div className="flex items-center gap-1 mb-2">
                          <Cpu className="w-3 h-3 text-gray-600" />
                          <span className="text-[10px] font-mono text-gray-600">{sa.model || sa.cost?.model}</span>
                        </div>
                      )}
                      {sa.resultPreview && (
                        <div className="mt-2">
                          <div className="text-[9px] font-mono text-gray-600 uppercase mb-1">Result Preview</div>
                          <pre className="font-mono text-[11px] bg-slate-900/50 p-2 rounded border border-slate-800 text-gray-400 overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap">
                            {sa.resultPreview}
                          </pre>
                        </div>
                      )}
                      {sa.error && (
                        <div className="flex items-start gap-2 mt-2">
                          <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
                          <p className="text-red-400 font-mono text-xs">{sa.error}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </TabsContent>
            )}

            {/* Cost Breakdown */}
            <TabsContent value="costs" className="p-6">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader className="pb-2 pt-4 px-4">
                      <CardTitle className="text-[10px] font-mono text-gray-500 uppercase">Input Tokens</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <div className="text-xl font-bold text-white font-mono">{(task.cost?.inputTokens || 0).toLocaleString()}</div>
                    </CardContent>
                  </Card>
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader className="pb-2 pt-4 px-4">
                      <CardTitle className="text-[10px] font-mono text-gray-500 uppercase">Output Tokens</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <div className="text-xl font-bold text-white font-mono">{(task.cost?.outputTokens || 0).toLocaleString()}</div>
                    </CardContent>
                  </Card>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader className="pb-2 pt-4 px-4">
                      <CardTitle className="text-[10px] font-mono text-gray-500 uppercase">Model Calls</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <div className="text-xl font-bold text-white font-mono">{task.cost?.modelCalls || 0}</div>
                    </CardContent>
                  </Card>
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader className="pb-2 pt-4 px-4">
                      <CardTitle className="text-[10px] font-mono text-gray-500 uppercase">Total Cost</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <div className="text-xl font-bold text-[#00ff88] font-mono">${(task.cost?.estimatedCost || 0).toFixed(4)}</div>
                    </CardContent>
                  </Card>
                </div>
                {task.cost?.model && (
                  <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800/50">
                    <div className="text-[10px] text-gray-500 font-mono uppercase mb-1">Model</div>
                    <div className="text-white font-mono text-sm">{task.cost.model}</div>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800/50">
                    <div className="text-[9px] text-gray-600 font-mono uppercase mb-1">Created</div>
                    <div className="text-gray-300 font-mono text-[11px]">{new Date(task.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800/50">
                    <div className="text-[9px] text-gray-600 font-mono uppercase mb-1">Started</div>
                    <div className="text-gray-300 font-mono text-[11px]">{task.startedAt ? new Date(task.startedAt).toLocaleString() : "-"}</div>
                  </div>
                  <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-800/50">
                    <div className="text-[9px] text-gray-600 font-mono uppercase mb-1">Completed</div>
                    <div className="text-gray-300 font-mono text-[11px]">{task.completedAt ? new Date(task.completedAt).toLocaleString() : "-"}</div>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
