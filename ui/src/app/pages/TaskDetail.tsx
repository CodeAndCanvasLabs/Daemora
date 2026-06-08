import { useParams, Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Wrench, CheckCircle2, XCircle } from "lucide-react";

import { api } from "../lib/api-client";
import { Card, Loading, Pill, PageHeader } from "../components/kit";

interface ToolCall {
  tool_name?: string; tool?: string; name?: string;
  args?: unknown; params?: unknown; input?: unknown;
  error?: string | null; result?: unknown; output?: unknown;
  durationMs?: number; duration?: number; ok?: boolean; status?: string;
}
interface Task { id: string; input?: string; status?: string; result?: string; error?: string; createdAt?: number; toolCalls?: ToolCall[] }

function pretty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function TaskDetail() {
  const { id } = useParams();
  // The API returns the task at top level (with toolCalls inside); older shape
  // nested it under `task`. Handle both.
  const q = useQuery({ queryKey: ["task", id], queryFn: () => api.get<Task & { task?: Task; toolCalls?: ToolCall[] }>(`/api/tasks/${id}`), enabled: !!id });
  const t = q.data?.task ?? q.data;
  const tools = q.data?.toolCalls ?? t?.toolCalls ?? [];

  return (
    <div>
      <Link to="/logs" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-[#00d9ff] mb-4"><ArrowLeft className="w-4 h-4" /> Logs</Link>
      {q.isLoading ? <Loading /> : !t ? <p className="text-sm text-gray-400">Task not found.</p> : (
        <div className="space-y-4 max-w-3xl">
          <PageHeader title="Task" description={t.id} actions={<Pill tone={t.status === "completed" ? "ok" : t.status === "failed" ? "warn" : "default"}>{t.status ?? "—"}</Pill>} />

          <Card className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Prompt</div>
            <div className="text-sm text-gray-200 whitespace-pre-wrap">{t.input || "—"}</div>
          </Card>

          {/* Tool timeline — what ran, what failed, why */}
          <Card className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">Steps ({tools.length})</div>
            {tools.length === 0 ? <p className="text-sm text-gray-500">No tool calls — the agent answered directly.</p> : (
              <div className="space-y-2">
                {tools.map((tc, i) => {
                  const name = tc.tool_name || tc.tool || tc.name || "tool";
                  const failed = !!tc.error || tc.ok === false || tc.status === "error";
                  const dur = tc.durationMs ?? tc.duration;
                  const args = pretty(tc.args ?? tc.params ?? tc.input);
                  const out = tc.error ? String(tc.error) : pretty(tc.result ?? tc.output);
                  return (
                    <div key={i} className={`rounded-lg border p-3 ${failed ? "border-red-500/40 bg-red-500/5" : "border-slate-800/60 bg-slate-900/30"}`}>
                      <div className="flex items-center gap-2">
                        {failed ? <XCircle className="w-4 h-4 text-red-400" /> : <CheckCircle2 className="w-4 h-4 text-[#00ff88]" />}
                        <Wrench className="w-3.5 h-3.5 text-gray-500" />
                        <span className="text-sm text-gray-200 font-medium">{name}</span>
                        {dur != null && <span className="ml-auto text-[11px] text-gray-500">{dur}ms</span>}
                      </div>
                      {args && <pre className="mt-2 text-[11px] text-gray-400 bg-slate-950/50 rounded p-2 overflow-auto max-h-32 whitespace-pre-wrap break-words">{args}</pre>}
                      {out && <pre className={`mt-2 text-[11px] rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-words ${failed ? "text-red-300 bg-red-950/30" : "text-gray-400 bg-slate-950/50"}`}>{out}</pre>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Result</div>
            {t.error ? <div className="text-sm text-red-400 whitespace-pre-wrap break-words">{t.error}</div> :
              <div className="prose prose-invert prose-sm max-w-none break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:break-words [&_pre]:overflow-auto"><ReactMarkdown remarkPlugins={[remarkGfm]}>{t.result || "_No result_"}</ReactMarkdown></div>}
          </Card>
        </div>
      )}
    </div>
  );
}
