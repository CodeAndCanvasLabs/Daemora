/**
 * useChatThread — chat state + streaming for ONE session, rebuilt clean.
 *
 * Encapsulates the (proven) Daemora SSE protocol so the UI components stay
 * presentational:
 *   - POST /api/chat { input, sessionId, attachments } → { taskId }
 *   - GET  /api/tasks/:taskId/stream   → per-task events (status/model/tool/text)
 *   - GET  /api/sessions/:id/stream    → session events (voice/channel-originated
 *     tasks stream here too, so inbound channel messages to the ACTIVE chat
 *     render live)
 *
 * Returns presentational state + a send() that takes plain Files.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiStreamUrl } from "../api";
import { queryClient, qk } from "./query";

export type AttachmentKind = "image" | "audio" | "video" | "document" | "file";

export interface ChatAttachment { kind: AttachmentKind; url: string; filename: string; mimeType: string; }
export interface ChatMessage { role: "user" | "assistant"; content: string; timestamp: string; attachments?: ChatAttachment[]; }
export interface ToolEvent { id: string; name: string; status: "running" | "done" | "error"; preview?: string; durationMs?: number; }

export function fileUrl(path: string): string {
  const token = document.querySelector('meta[name="api-token"]')?.getAttribute("content") || "";
  return `/api/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`;
}

export function kindForMime(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || mime.includes("officedocument") || mime === "application/msword" || mime === "application/vnd.ms-excel") return "document";
  return "file";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

interface ApiAttachment { kind: AttachmentKind; path: string; mimeType: string; filename?: string }

const ACTIVE_TASK_KEY = "daemora_active_task";

function summarizeParams(params: unknown): string {
  if (!params) return "";
  const clip = (s: string) => (s.length > 40 ? s.slice(0, 40) + "…" : s);
  if (typeof params === "string") return clip(params);
  if (Array.isArray(params)) { const f = params.find((p) => typeof p === "string"); return f ? clip(f) : ""; }
  if (typeof params === "object") {
    for (const k of ["path", "file", "filePath", "url", "query", "command", "prompt", "name"]) {
      const v = (params as Record<string, unknown>)[k];
      if (typeof v === "string" && v) return clip(v);
    }
  }
  return "";
}

export interface UseChatThread {
  messages: ChatMessage[];
  toolEvents: ToolEvent[];
  status: string | null;
  isLoading: boolean;
  initialized: boolean;
  send: (text: string, files: File[]) => Promise<void>;
  clear: () => Promise<void>;
}

export function useChatThread(sessionId: string): UseChatThread {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const taskEsRef = useRef<EventSource | null>(null);
  const pendingSendRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setMessages((data.messages || []).map((m: ChatMessage & { attachments?: ApiAttachment[] }) => ({
          ...m,
          content: m.role === "user" ? m.content.replace(/^\[Voice mode:[^\]]+\]\s*/, "") : m.content,
          ...(m.attachments && m.attachments.length > 0
            ? { attachments: m.attachments.map((a) => ({ kind: a.kind, url: fileUrl(a.path), filename: a.filename ?? a.path.split("/").pop() ?? "file", mimeType: a.mimeType })) }
            : {}),
        })));
      } else {
        await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify({ sessionId }) });
      }
    } catch { /* ignore */ } finally { setInitialized(true); }
  }, [sessionId]);

  const clear = useCallback(async () => {
    try {
      await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify({ sessionId }) });
      setMessages([]); setToolEvents([]); setStatus(null);
      sessionStorage.removeItem(ACTIVE_TASK_KEY);
    } catch { /* ignore */ }
  }, [sessionId]);

  // Per-task stream: status, model, tool, token deltas for the task we started.
  const connectTask = useCallback((taskId: string) => {
    taskEsRef.current?.close();
    sessionStorage.setItem(ACTIVE_TASK_KEY, taskId);
    const es = new EventSource(apiStreamUrl(`/api/tasks/${taskId}/stream`));
    taskEsRef.current = es;
    const done = () => { sessionStorage.removeItem(ACTIVE_TASK_KEY); es.close(); if (taskEsRef.current === es) taskEsRef.current = null; };

    es.addEventListener("task:state", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (d.status === "completed") { setIsLoading(false); setStatus(null); void load(); done(); }
      else if (d.status === "failed") {
        setMessages((p) => [...p, { role: "assistant", content: `**SYSTEM ERROR:** ${d.error || "Task failed"}`, timestamp: new Date().toISOString() }]);
        setIsLoading(false); setStatus(null); done();
      } else if (d.status === "running") setStatus("Processing…");
    });
    es.addEventListener("model:called", (e) => {
      try { const d = JSON.parse((e as MessageEvent).data); const it = d.iteration || d.loop || ""; setStatus(`Thinking${it ? ` (step ${it})` : ""}…`); }
      catch { setStatus("Thinking…"); }
    });
    es.addEventListener("tool:before", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        const name = d.tool_name || d.tool || "tool";
        const preview = summarizeParams(d.params);
        const id = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setToolEvents((p) => [...p, { id, name, status: "running", preview }]);
        setStatus(`Running ${name}${preview ? ` · ${preview}` : ""}…`);
      } catch { /* ignore */ }
    });
    es.addEventListener("tool:after", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        const name = d.tool_name || d.tool || "tool";
        const dur = typeof d.duration === "number" ? d.duration : undefined;
        const next: "done" | "error" = d.error ? "error" : "done";
        setToolEvents((p) => {
          const arr = [...p];
          for (let i = arr.length - 1; i >= 0; i--) if (arr[i].name === name && arr[i].status === "running") { arr[i] = { ...arr[i], status: next, durationMs: dur }; break; }
          return arr;
        });
        setStatus(next === "error" ? `${name} failed` : `Using ${name}…`);
      } catch { setStatus("Using tool…"); }
    });
    // Token streaming for THIS task: append deltas to a placeholder assistant msg.
    let streaming = false;
    es.addEventListener("text:delta", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        const delta = d.delta || ""; if (!delta) return;
        setMessages((prev) => {
          if (!streaming) { streaming = true; return [...prev, { role: "assistant", content: delta, timestamp: new Date().toISOString() }]; }
          const arr = [...prev]; const last = arr[arr.length - 1];
          if (last?.role === "assistant") arr[arr.length - 1] = { ...last, content: last.content + delta };
          return arr;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("text:end", () => { streaming = false; });
    es.onerror = () => { /* EventSource auto-retries; task:state completion closes us */ };
  }, [load]);

  const send = useCallback(async (text: string, files: File[]) => {
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    const followUp = isLoading;
    const isFirst = messages.length === 0; // name the chat from its first message
    const bodyText = trimmed || (files.length ? "(see attached)" : "");
    const optimistic: ChatAttachment[] = files.map((f) => ({ kind: kindForMime(f.type || ""), url: URL.createObjectURL(f), filename: f.name, mimeType: f.type || "application/octet-stream" }));
    setMessages((p) => [...p, { role: "user", content: bodyText, timestamp: new Date().toISOString(), ...(optimistic.length ? { attachments: optimistic } : {}) }]);
    pendingSendRef.current = true;
    if (!followUp) { setIsLoading(true); setStatus("Queuing…"); setToolEvents([]); }
    else setStatus("Follow-up sent — agent will pick it up between steps");

    try {
      const encoded = files.length
        ? await Promise.all(files.map(async (f) => ({ filename: f.name || `paste-${Date.now()}`, mimeType: f.type || "application/octet-stream", base64: await fileToBase64(f), kind: kindForMime(f.type || "") })))
        : undefined;
      const res = await apiFetch("/api/chat", { method: "POST", body: JSON.stringify({ input: bodyText, sessionId, ...(encoded ? { attachments: encoded } : {}) }) });
      if (!res.ok) throw new Error(res.statusText || "request failed");
      const data = await res.json();
      // Auto-name a brand-new chat from its first message.
      if (isFirst && trimmed) {
        const title = trimmed.replace(/\s+/g, " ").trim().slice(0, 48);
        apiFetch(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title }) })
          .then(() => queryClient.invalidateQueries({ queryKey: qk.sessions }))
          .catch(() => { /* non-fatal */ });
      }
      if (followUp) return;
      if (data.taskId) connectTask(data.taskId);
      else if (data.result) { setMessages((p) => [...p, { role: "assistant", content: data.result, timestamp: new Date().toISOString() }]); setIsLoading(false); setStatus(null); }
    } catch (err) {
      setMessages((p) => [...p, { role: "assistant", content: `**SYSTEM ERROR:** ${err instanceof Error ? err.message : "failed"}`, timestamp: new Date().toISOString() }]);
      if (!followUp) { setIsLoading(false); setStatus(null); }
    } finally { pendingSendRef.current = false; }
  }, [isLoading, sessionId, connectTask, messages.length]);

  // Initial load + reconnect to an in-flight task (e.g. after a remount).
  useEffect(() => {
    void load();
    const pending = sessionStorage.getItem(ACTIVE_TASK_KEY);
    if (pending) {
      apiFetch(`/api/tasks/${pending}`).then((r) => (r.ok ? r.json() : null)).then((t) => {
        if (t && (t.status === "pending" || t.status === "running")) { setIsLoading(true); setStatus("Reconnecting…"); connectTask(pending); }
        else sessionStorage.removeItem(ACTIVE_TASK_KEY);
      }).catch(() => sessionStorage.removeItem(ACTIVE_TASK_KEY));
    }
    return () => { taskEsRef.current?.close(); taskEsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Session stream: render voice/channel-originated tasks (not our text task)
  // live — this is how inbound channel messages to the ACTIVE chat appear.
  useEffect(() => {
    const es = new EventSource(apiStreamUrl(`/api/sessions/${sessionId}/stream`));
    let active = false;
    es.addEventListener("task:created", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        const mine = sessionStorage.getItem(ACTIVE_TASK_KEY);
        if (pendingSendRef.current) return;
        if (d.taskId && d.taskId !== mine && d.input) {
          const clean = String(d.input).replace(/^\[Voice mode:[^\]]+\]\s*/, "");
          setMessages((prev) => { const last = prev[prev.length - 1]; if (last?.role === "user" && last.content === clean) return prev; return [...prev, { role: "user", content: clean, timestamp: new Date().toISOString() }]; });
          active = false;
        }
      } catch { /* ignore */ }
    });
    es.addEventListener("text:delta", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        const mine = sessionStorage.getItem(ACTIVE_TASK_KEY);
        if (!d.taskId || d.taskId === mine) return;
        const delta = d.delta || ""; if (!delta) return;
        setMessages((prev) => {
          if (!active) { active = true; return [...prev, { role: "assistant", content: delta, timestamp: new Date().toISOString() }]; }
          const arr = [...prev]; const last = arr[arr.length - 1];
          if (last?.role === "assistant") arr[arr.length - 1] = { ...last, content: last.content + delta };
          return arr;
        });
      } catch { /* ignore */ }
    });
    es.addEventListener("text:end", () => { active = false; });
    es.addEventListener("task:completed", (e) => {
      try { const d = JSON.parse((e as MessageEvent).data); const mine = sessionStorage.getItem(ACTIVE_TASK_KEY); if (d?.id && d.id !== mine) void load(); } catch { /* ignore */ }
      active = false;
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { messages, toolEvents, status, isLoading, initialized, send, clear };
}
